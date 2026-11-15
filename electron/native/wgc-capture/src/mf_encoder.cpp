#include "mf_encoder.h"
#include "frame_padding.h"
#include <mfapi.h>
#include <mferror.h>
#include <codecapi.h>
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <cstring>
#include "../../common/bt709_video.h"

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "mfuuid.lib")

static UINT32 calculateScreenRecordingBitrate(int width, int height, int fps) {
    constexpr uint64_t kFourKPixels = 3840ULL * 2160ULL;
    constexpr uint64_t kQhdPixels = 2560ULL * 1440ULL;
    constexpr UINT32 kBitrate4K = 45000000;
    constexpr UINT32 kBitrateQhd = 28000000;
    constexpr UINT32 kBitrateBase = 18000000;
    constexpr double kHighFrameRateBoost = 1.35;

    const uint64_t pixels =
        static_cast<uint64_t>((std::max)(width, 1)) *
        static_cast<uint64_t>((std::max)(height, 1));
    const UINT32 baseBitrate =
        pixels >= kFourKPixels ? kBitrate4K :
        pixels >= kQhdPixels ? kBitrateQhd :
        kBitrateBase;
    const double boost = fps >= 60 ? kHighFrameRateBoost : 1.0;
    return static_cast<UINT32>(static_cast<double>(baseBitrate) * boost + 0.5);
}

MFEncoder::MFEncoder() {}

MFEncoder::~MFEncoder() {
    finalize();
}

bool MFEncoder::initialize(const std::wstring& outputPath, int width, int height, int fps,
                           ID3D11Device* device, ID3D11DeviceContext* context) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (initialized_) return false;

    if (fps <= 0) {
        std::cerr << "ERROR: Encoder fps must be positive, got " << fps << std::endl;
        return false;
    }

    if (width % 2 != 0 || height % 2 != 0) {
        std::cerr << "ERROR: Encoder dimensions must be even, got " << width << "x" << height << std::endl;
        return false;
    }

    width_ = width;
    height_ = height;
    fps_ = fps;
    device_ = device;
    context_ = context;

    HRESULT hr = MFStartup(MF_VERSION);
    if (FAILED(hr)) {
        std::cerr << "ERROR: MFStartup failed: 0x" << std::hex << hr << std::endl;
        return false;
    }

    // Output media type (H.264)
    ComPtr<IMFMediaType> outputType;
    hr = MFCreateMediaType(&outputType);
    if (FAILED(hr)) return false;

    outputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    outputType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
    const UINT32 videoBitrate = calculateScreenRecordingBitrate(width_, height_, fps_);
    outputType->SetUINT32(MF_MT_AVG_BITRATE, videoBitrate);
    MFSetAttributeSize(outputType.Get(), MF_MT_FRAME_SIZE, width_, height_);
    MFSetAttributeRatio(outputType.Get(), MF_MT_FRAME_RATE, fps_, 1);
    MFSetAttributeRatio(outputType.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    outputType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    hr = setBt709LimitedVideoAttributes(outputType.Get());
    if (FAILED(hr)) return false;
    std::cerr << "Encoder bitrate: " << videoBitrate << " bps for "
              << width_ << "x" << height_ << "@" << fps_ << "fps" << std::endl;

    // Input media type (NV12)
    ComPtr<IMFMediaType> inputType;
    hr = MFCreateMediaType(&inputType);
    if (FAILED(hr)) return false;

    inputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    inputType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    MFSetAttributeSize(inputType.Get(), MF_MT_FRAME_SIZE, width_, height_);
    MFSetAttributeRatio(inputType.Get(), MF_MT_FRAME_RATE, fps_, 1);
    MFSetAttributeRatio(inputType.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    inputType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    hr = setBt709LimitedVideoAttributes(inputType.Get());
    if (FAILED(hr)) return false;

    // Create SinkWriter with MPEG4 container
    ComPtr<IMFAttributes> writerAttrs;
    hr = MFCreateAttributes(&writerAttrs, 3);
    if (FAILED(hr)) return false;

    writerAttrs->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
    writerAttrs->SetUINT32(MF_LOW_LATENCY, TRUE);

    gpuPipelineEnabled_ = initializeGpuVideoProcessorLocked();
    if (gpuPipelineEnabled_ && dxgiDeviceManager_) {
        writerAttrs->SetUnknown(MF_SINK_WRITER_D3D_MANAGER, dxgiDeviceManager_.Get());
    }

    hr = MFCreateSinkWriterFromURL(outputPath.c_str(), nullptr, writerAttrs.Get(), &sinkWriter_);
    if (FAILED(hr) && gpuPipelineEnabled_) {
        std::cerr << "WARN: MFCreateSinkWriterFromURL with D3D manager failed (0x"
                  << std::hex << hr << std::dec << "), falling back to CPU staging" << std::endl;
        releaseGpuVideoProcessorLocked();
        writerAttrs.Reset();
        if (SUCCEEDED(MFCreateAttributes(&writerAttrs, 2))) {
            writerAttrs->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
            writerAttrs->SetUINT32(MF_LOW_LATENCY, TRUE);
            hr = MFCreateSinkWriterFromURL(outputPath.c_str(), nullptr, writerAttrs.Get(), &sinkWriter_);
        }
    }
    if (FAILED(hr)) {
        std::cerr << "ERROR: MFCreateSinkWriterFromURL failed: 0x" << std::hex << hr << std::endl;
        releaseGpuVideoProcessorLocked();
        return false;
    }

    hr = sinkWriter_->AddStream(outputType.Get(), &streamIndex_);
    if (FAILED(hr)) {
        std::cerr << "ERROR: AddStream failed: 0x" << std::hex << hr << std::endl;
        releaseGpuVideoProcessorLocked();
        return false;
    }

    hr = sinkWriter_->SetInputMediaType(streamIndex_, inputType.Get(), nullptr);
    if (FAILED(hr)) {
        std::cerr << "ERROR: SetInputMediaType failed: 0x" << std::hex << hr << std::endl;
        releaseGpuVideoProcessorLocked();
        return false;
    }

    hr = sinkWriter_->BeginWriting();
    if (FAILED(hr)) {
        std::cerr << "ERROR: BeginWriting failed: 0x" << std::hex << hr << std::endl;
        releaseGpuVideoProcessorLocked();
        return false;
    }

    // Pre-allocate staging texture (kept ready for transparent fallback if GPU path fails)
    D3D11_TEXTURE2D_DESC stagingDesc = {};
    stagingDesc.Width = width_;
    stagingDesc.Height = height_;
    stagingDesc.MipLevels = 1;
    stagingDesc.ArraySize = 1;
    stagingDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    stagingDesc.SampleDesc.Count = 1;
    stagingDesc.Usage = D3D11_USAGE_STAGING;
    stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

    hr = device_->CreateTexture2D(&stagingDesc, nullptr, &stagingTexture_);
    if (FAILED(hr)) {
        std::cerr << "ERROR: Failed to create staging texture: 0x" << std::hex << hr << std::endl;
        releaseGpuVideoProcessorLocked();
        return false;
    }

    // WGC window captures can change frame size while recording. Keep the muxer
    // output dimensions stable by compositing resized frames into this fixed
    // BGRA surface before GPU conversion or CPU readback.
    D3D11_TEXTURE2D_DESC compositeDesc = {};
    compositeDesc.Width = width_;
    compositeDesc.Height = height_;
    compositeDesc.MipLevels = 1;
    compositeDesc.ArraySize = 1;
    compositeDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    compositeDesc.SampleDesc.Count = 1;
    compositeDesc.Usage = D3D11_USAGE_DEFAULT;
    compositeDesc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;

    hr = device_->CreateTexture2D(&compositeDesc, nullptr, &resizeCompositeTexture_);
    if (FAILED(hr)) {
        compositeDesc.BindFlags = D3D11_BIND_RENDER_TARGET;
        hr = device_->CreateTexture2D(&compositeDesc, nullptr, &resizeCompositeTexture_);
    }
    if (FAILED(hr)) {
        std::cerr << "ERROR: Failed to create resize composite texture: 0x" << std::hex << hr << std::endl;
        releaseGpuVideoProcessorLocked();
        return false;
    }

    hr = device_->CreateRenderTargetView(resizeCompositeTexture_.Get(), nullptr, &resizeCompositeView_);
    if (FAILED(hr)) {
        std::cerr << "ERROR: Failed to create resize composite view: 0x" << std::hex << hr << std::endl;
        releaseGpuVideoProcessorLocked();
        return false;
    }

    // Pre-allocate NV12 buffer (used only when CPU fallback is active)
    const int ySize = width_ * height_;
    const int uvSize = (width_ / 2) * (height_ / 2) * 2;
    nv12Buffer_.resize(ySize + uvSize);
    lastFrameBuffer_.clear();
    hasLastGpuFrame_ = false;
    firstSampleTimeHns_ = -1;
    lastSampleEndTimeHns_ = -1;

    initialized_ = true;
    return true;
}

bool MFEncoder::initializeGpuVideoProcessorLocked() {
    if (!device_ || !context_) return false;

    ComPtr<ID3D10Multithread> multithread;
    if (SUCCEEDED(device_->QueryInterface(IID_PPV_ARGS(&multithread))) && multithread) {
        multithread->SetMultithreadProtected(TRUE);
    }

    HRESULT hr = device_->QueryInterface(IID_PPV_ARGS(&videoDevice_));
    if (FAILED(hr) || !videoDevice_) return false;

    hr = context_->QueryInterface(IID_PPV_ARGS(&videoContext_));
    if (FAILED(hr) || !videoContext_) {
        releaseGpuVideoProcessorLocked();
        return false;
    }

    hr = MFCreateDXGIDeviceManager(&dxgiResetToken_, &dxgiDeviceManager_);
    if (FAILED(hr) || !dxgiDeviceManager_) {
        releaseGpuVideoProcessorLocked();
        return false;
    }

    hr = dxgiDeviceManager_->ResetDevice(device_, dxgiResetToken_);
    if (FAILED(hr)) {
        releaseGpuVideoProcessorLocked();
        return false;
    }

    D3D11_VIDEO_PROCESSOR_CONTENT_DESC contentDesc = {};
    contentDesc.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    contentDesc.InputFrameRate.Numerator = static_cast<UINT>((std::max)(fps_, 1));
    contentDesc.InputFrameRate.Denominator = 1;
    contentDesc.InputWidth = static_cast<UINT>(width_);
    contentDesc.InputHeight = static_cast<UINT>(height_);
    contentDesc.OutputFrameRate.Numerator = static_cast<UINT>((std::max)(fps_, 1));
    contentDesc.OutputFrameRate.Denominator = 1;
    contentDesc.OutputWidth = static_cast<UINT>(width_);
    contentDesc.OutputHeight = static_cast<UINT>(height_);
    contentDesc.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;

    hr = videoDevice_->CreateVideoProcessorEnumerator(&contentDesc, &videoProcessorEnum_);
    if (FAILED(hr) || !videoProcessorEnum_) {
        releaseGpuVideoProcessorLocked();
        return false;
    }

    hr = videoDevice_->CreateVideoProcessor(videoProcessorEnum_.Get(), 0, &videoProcessor_);
    if (FAILED(hr) || !videoProcessor_) {
        releaseGpuVideoProcessorLocked();
        return false;
    }

    D3D11_VIDEO_PROCESSOR_COLOR_SPACE inputColorSpace = {};
    inputColorSpace.Usage = 0;
    inputColorSpace.RGB_Range = 0; // Full range [0..255] desktop BGRA
    inputColorSpace.YCbCr_Matrix = 1; // BT.709
    inputColorSpace.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255;
    videoContext_->VideoProcessorSetStreamColorSpace(videoProcessor_.Get(), 0, &inputColorSpace);

    D3D11_VIDEO_PROCESSOR_COLOR_SPACE outputColorSpace = {};
    outputColorSpace.Usage = 0;
    outputColorSpace.RGB_Range = 1;
    outputColorSpace.YCbCr_Matrix = 1; // BT.709
    outputColorSpace.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
    videoContext_->VideoProcessorSetOutputColorSpace(videoProcessor_.Get(), &outputColorSpace);

    D3D11_TEXTURE2D_DESC nv12Desc = {};
    nv12Desc.Width = static_cast<UINT>(width_);
    nv12Desc.Height = static_cast<UINT>(height_);
    nv12Desc.MipLevels = 1;
    nv12Desc.ArraySize = 1;
    nv12Desc.Format = DXGI_FORMAT_NV12;
    nv12Desc.SampleDesc.Count = 1;
    nv12Desc.Usage = D3D11_USAGE_DEFAULT;
    nv12Desc.BindFlags = D3D11_BIND_RENDER_TARGET;

    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC outputViewDesc = {};
    outputViewDesc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    outputViewDesc.Texture2D.MipSlice = 0;

    for (size_t i = 0; i < kGpuNv12PoolSize; ++i) {
        hr = device_->CreateTexture2D(&nv12Desc, nullptr, &gpuNv12Textures_[i]);
        if (FAILED(hr) || !gpuNv12Textures_[i]) {
            releaseGpuVideoProcessorLocked();
            return false;
        }
        hr = videoDevice_->CreateVideoProcessorOutputView(
            gpuNv12Textures_[i].Get(),
            videoProcessorEnum_.Get(),
            &outputViewDesc,
            &gpuNv12OutputViews_[i]);
        if (FAILED(hr) || !gpuNv12OutputViews_[i]) {
            releaseGpuVideoProcessorLocked();
            return false;
        }
    }

    hr = device_->CreateTexture2D(&nv12Desc, nullptr, &lastGpuFrameTexture_);
    if (FAILED(hr) || !lastGpuFrameTexture_) {
        releaseGpuVideoProcessorLocked();
        return false;
    }

    gpuNv12PoolIndex_ = 0;
    hasLastGpuFrame_ = false;
    std::cerr << "INFO: Initialized zero-copy D3D11 video processor (BGRA -> NV12) for WGC capture" << std::endl;
    return true;
}

void MFEncoder::releaseGpuVideoProcessorLocked() {
    gpuPipelineEnabled_ = false;
    hasLastGpuFrame_ = false;
    lastGpuFrameTexture_.Reset();
    for (size_t i = 0; i < kGpuNv12PoolSize; ++i) {
        gpuNv12OutputViews_[i].Reset();
        gpuNv12Textures_[i].Reset();
    }
    videoProcessor_.Reset();
    videoProcessorEnum_.Reset();
    videoContext_.Reset();
    videoDevice_.Reset();
    dxgiDeviceManager_.Reset();
    dxgiResetToken_ = 0;
}

bool MFEncoder::convertBgraTextureToGpuNv12Locked(
    ID3D11Texture2D* sourceBgraTexture,
    ID3D11Texture2D** outNv12Texture
) {
    if (!gpuPipelineEnabled_ || !videoDevice_ || !videoContext_ || !videoProcessor_ || !videoProcessorEnum_) {
        return false;
    }

    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC inputViewDesc = {};
    inputViewDesc.FourCC = 0;
    inputViewDesc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    inputViewDesc.Texture2D.MipSlice = 0;
    inputViewDesc.Texture2D.ArraySlice = 0;

    ComPtr<ID3D11VideoProcessorInputView> inputView;
    HRESULT hr = videoDevice_->CreateVideoProcessorInputView(
        sourceBgraTexture,
        videoProcessorEnum_.Get(),
        &inputViewDesc,
        &inputView);
    if (FAILED(hr) || !inputView) {
        return false;
    }

    const size_t slot = gpuNv12PoolIndex_ % kGpuNv12PoolSize;
    gpuNv12PoolIndex_ = (gpuNv12PoolIndex_ + 1) % kGpuNv12PoolSize;

    ID3D11Texture2D* targetNv12 = gpuNv12Textures_[slot].Get();
    ID3D11VideoProcessorOutputView* outputView = gpuNv12OutputViews_[slot].Get();
    if (!targetNv12 || !outputView) {
        return false;
    }

    D3D11_VIDEO_PROCESSOR_STREAM stream = {};
    stream.Enable = TRUE;
    stream.pInputSurface = inputView.Get();

    hr = videoContext_->VideoProcessorBlt(
        videoProcessor_.Get(),
        outputView,
        0,
        1,
        &stream);
    if (FAILED(hr)) {
        return false;
    }

    *outNv12Texture = targetNv12;
    return true;
}

bool MFEncoder::writeFrame(ID3D11Texture2D* texture, int64_t timestampHns) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (!initialized_ || !sinkWriter_) return false;

    D3D11_TEXTURE2D_DESC sourceDesc = {};
    texture->GetDesc(&sourceDesc);

    ID3D11Texture2D* sourceBgraTexture = texture;
    if (sourceDesc.Width != static_cast<UINT>(width_) ||
        sourceDesc.Height != static_cast<UINT>(height_)) {
        if (!resizeCompositeTexture_ || !resizeCompositeView_) return false;

        const FLOAT clearColor[4] = {0.0f, 0.0f, 0.0f, 1.0f};
        context_->ClearRenderTargetView(resizeCompositeView_.Get(), clearColor);

        D3D11_BOX sourceBox = {};
        sourceBox.left = 0;
        sourceBox.top = 0;
        sourceBox.front = 0;
        sourceBox.right = (std::min)(sourceDesc.Width, static_cast<UINT>(width_));
        sourceBox.bottom = (std::min)(sourceDesc.Height, static_cast<UINT>(height_));
        sourceBox.back = 1;

        if (sourceBox.right == 0 || sourceBox.bottom == 0) return false;

        context_->CopySubresourceRegion(
            resizeCompositeTexture_.Get(),
            0,
            0,
            0,
            0,
            texture,
            0,
            &sourceBox);
        sourceBgraTexture = resizeCompositeTexture_.Get();
    }

    int64_t normalizedTimestampHns = 0;
    normalizeWriteTimestampHnsLocked(timestampHns, normalizedTimestampHns);
    const int64_t frameDurationHns = 10000000LL / fps_;

    // Fast path: GPU BGRA -> NV12 conversion + DXGI surface sample
    if (gpuPipelineEnabled_) {
        ID3D11Texture2D* nv12Texture = nullptr;
        if (convertBgraTextureToGpuNv12Locked(sourceBgraTexture, &nv12Texture) && nv12Texture) {
            if (hasLastGpuFrame_ && !extendLastFrameToLocked(normalizedTimestampHns, false)) {
                return false;
            }
            if (writeGpuNv12SampleLocked(nv12Texture, normalizedTimestampHns, frameDurationHns)) {
                if (lastGpuFrameTexture_) {
                    context_->CopyResource(lastGpuFrameTexture_.Get(), nv12Texture);
                    hasLastGpuFrame_ = true;
                }
                return true;
            }
        }
        std::cerr << "WARN: GPU NV12 encode path failed; falling back to CPU staging" << std::endl;
        gpuPipelineEnabled_ = false;
    }

    context_->CopyResource(stagingTexture_.Get(), sourceBgraTexture);

    D3D11_MAPPED_SUBRESOURCE mapped;
    HRESULT hr = context_->Map(stagingTexture_.Get(), 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr)) return false;

    // Convert full-range desktop BGRA to explicitly tagged BT.709 video-range NV12.
    const uint8_t* bgra = static_cast<const uint8_t*>(mapped.pData);
    const int bgraPitch = static_cast<int>(mapped.RowPitch);
    convertBgraToBt709LimitedNv12(bgra, bgraPitch, width_, height_, nv12Buffer_);

    context_->Unmap(stagingTexture_.Get(), 0);

    // WGC may stop delivering frames while the scene is static; keep the MP4
    // timeline continuous with one duration-bearing sample for each gap.
    if (!lastFrameBuffer_.empty() && !extendLastFrameToLocked(normalizedTimestampHns, false)) {
        return false;
    }

    bool wroteSample = writeNv12SampleLocked(
        nv12Buffer_, normalizedTimestampHns, frameDurationHns);
    if (wroteSample) {
        if (lastFrameBuffer_.size() != nv12Buffer_.size()) {
            lastFrameBuffer_.resize(nv12Buffer_.size());
        }
        std::swap(nv12Buffer_, lastFrameBuffer_);
    }
    return wroteSample;
}

bool MFEncoder::extendLastFrameTo(int64_t timestampHns) {
    std::lock_guard<std::mutex> lock(mutex_);

    int64_t normalizedTimestampHns = 0;
    if (!normalizeTimelineTimestampHnsLocked(timestampHns, normalizedTimestampHns)) {
        return false;
    }

    return extendLastFrameToLocked(normalizedTimestampHns, true);
}

void MFEncoder::normalizeWriteTimestampHnsLocked(int64_t timestampHns, int64_t& normalizedTimestampHns) {
    if (firstSampleTimeHns_ < 0) {
        firstSampleTimeHns_ = timestampHns < 0 ? 0 : timestampHns;
    }

    normalizedTimestampHns = timestampHns - firstSampleTimeHns_;
    if (normalizedTimestampHns < 0) {
        normalizedTimestampHns = 0;
    }
}

bool MFEncoder::normalizeTimelineTimestampHnsLocked(
    int64_t timestampHns,
    int64_t& normalizedTimestampHns
) const {
    if (firstSampleTimeHns_ < 0) return false;

    normalizedTimestampHns = timestampHns - firstSampleTimeHns_;
    if (normalizedTimestampHns < 0) {
        normalizedTimestampHns = 0;
    }
    return true;
}

bool MFEncoder::extendLastFrameToLocked(int64_t timestampHns, bool includePartialFrame) {
    if (!initialized_ || !sinkWriter_) return false;
    if (gpuPipelineEnabled_) {
        if (!hasLastGpuFrame_ || !lastGpuFrameTexture_) return false;
    } else if (lastFrameBuffer_.empty()) {
        return false;
    }
    if (lastSampleEndTimeHns_ < 0) return false;

    if (fps_ <= 0) return false;
    const int64_t frameDurationHns = 10000000LL / fps_;
    if (frameDurationHns <= 0) return false;
    // Avoid an extra sample for normal sub-frame timestamp jitter. At Stop,
    // cover even a fractional final frame so the recording reaches its endpoint.
    const auto padding = planFramePadding(
        lastSampleEndTimeHns_, timestampHns, includePartialFrame ? 1 : frameDurationHns);
    if (padding.durationHns == 0) return true;

    // Encoding a duplicate at every nominal frame interval creates unbounded
    // work after a static scene or a slow encoder. One sample holds the same
    // image through the entire gap, including a fractional final frame at Stop.
    if (gpuPipelineEnabled_ && hasLastGpuFrame_ && lastGpuFrameTexture_) {
        return writeGpuNv12SampleLocked(
            lastGpuFrameTexture_.Get(), padding.timestampHns, padding.durationHns);
    }
    return writeNv12SampleLocked(
        lastFrameBuffer_, padding.timestampHns, padding.durationHns);
}

bool MFEncoder::writeGpuNv12SampleLocked(
    ID3D11Texture2D* nv12Texture,
    int64_t timestampHns,
    int64_t durationHns
) {
    if (!nv12Texture || durationHns <= 0) return false;

    ComPtr<IMFMediaBuffer> buffer;
    HRESULT hr = MFCreateDXGISurfaceBuffer(
        __uuidof(ID3D11Texture2D),
        nv12Texture,
        0,
        FALSE,
        &buffer);
    if (FAILED(hr) || !buffer) return false;

    const DWORD frameBytes = static_cast<DWORD>(width_ * height_ * 3 / 2);
    ComPtr<IMF2DBuffer> buffer2D;
    DWORD contiguousLength = frameBytes;
    if (SUCCEEDED(buffer.As(&buffer2D)) && buffer2D) {
        DWORD queriedLength = 0;
        if (SUCCEEDED(buffer2D->GetContiguousLength(&queriedLength)) && queriedLength > 0) {
            contiguousLength = queriedLength;
        }
    }
    buffer->SetCurrentLength(contiguousLength);

    ComPtr<IMFSample> sample;
    hr = MFCreateSample(&sample);
    if (FAILED(hr) || !sample) return false;

    sample->AddBuffer(buffer.Get());
    sample->SetSampleTime(timestampHns);
    sample->SetSampleDuration(durationHns);

    hr = sinkWriter_->WriteSample(streamIndex_, sample.Get());
    if (FAILED(hr)) {
        std::cerr << "ERROR: WriteSample (DXGI surface) failed: 0x" << std::hex << hr << std::dec << std::endl;
        return false;
    }

    lastSampleEndTimeHns_ = timestampHns + durationHns;
    return true;
}

bool MFEncoder::writeNv12SampleLocked(
    const std::vector<uint8_t>& frameBuffer,
    int64_t timestampHns,
    int64_t durationHns
) {
    if (frameBuffer.empty() || durationHns <= 0) return false;

    // Create MF sample
    DWORD bufferSize = static_cast<DWORD>(frameBuffer.size());
    ComPtr<IMFMediaBuffer> buffer;
    HRESULT hr = MFCreateMemoryBuffer(bufferSize, &buffer);
    if (FAILED(hr)) return false;

    BYTE* bufferData = nullptr;
    hr = buffer->Lock(&bufferData, nullptr, nullptr);
    if (FAILED(hr)) return false;

    std::memcpy(bufferData, frameBuffer.data(), bufferSize);
    buffer->Unlock();
    buffer->SetCurrentLength(bufferSize);

    ComPtr<IMFSample> sample;
    hr = MFCreateSample(&sample);
    if (FAILED(hr)) return false;

    sample->AddBuffer(buffer.Get());
    sample->SetSampleTime(timestampHns);
    sample->SetSampleDuration(durationHns);

    hr = sinkWriter_->WriteSample(streamIndex_, sample.Get());
    if (FAILED(hr)) {
        std::cerr << "ERROR: WriteSample failed: 0x" << std::hex << hr << std::endl;
    }
    if (SUCCEEDED(hr)) {
        lastSampleEndTimeHns_ = timestampHns + durationHns;
    }
    return SUCCEEDED(hr);
}

bool MFEncoder::finalize() {
    std::lock_guard<std::mutex> lock(mutex_);

    if (!initialized_) return false;
    if (!sinkWriter_) return false;

    HRESULT hr = sinkWriter_->Finalize();
    if (FAILED(hr)) {
        std::cerr << "ERROR: SinkWriter Finalize failed: 0x" << std::hex << hr << std::endl;
    }

    initialized_ = false;
    sinkWriter_.Reset();
    releaseGpuVideoProcessorLocked();
    stagingTexture_.Reset();
    resizeCompositeView_.Reset();
    resizeCompositeTexture_.Reset();
    nv12Buffer_.clear();
    lastFrameBuffer_.clear();
    nv12Buffer_.shrink_to_fit();
    lastFrameBuffer_.shrink_to_fit();
    firstSampleTimeHns_ = -1;
    lastSampleEndTimeHns_ = -1;
    MFShutdown();
    return SUCCEEDED(hr);
}
