#pragma once

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <d3d11.h>
#include <wrl/client.h>
#include <mutex>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

class MFEncoder {
public:
    MFEncoder();
    ~MFEncoder();

    bool initialize(const std::wstring& outputPath, int width, int height, int fps,
                    ID3D11Device* device, ID3D11DeviceContext* context);
    bool writeFrame(ID3D11Texture2D* texture, int64_t timestampHns);
    bool extendLastFrameTo(int64_t timestampHns);
    bool finalize();

private:
    bool initializeGpuVideoProcessorLocked();
    void releaseGpuVideoProcessorLocked();
    bool convertBgraTextureToGpuNv12Locked(ID3D11Texture2D* sourceBgraTexture,
                                           ID3D11Texture2D** outNv12Texture);
    void normalizeWriteTimestampHnsLocked(int64_t timestampHns, int64_t& normalizedTimestampHns);
    bool normalizeTimelineTimestampHnsLocked(int64_t timestampHns, int64_t& normalizedTimestampHns) const;
    bool extendLastFrameToLocked(int64_t timestampHns, bool includePartialFrame);
    bool writeNv12SampleLocked(const std::vector<uint8_t>& frameBuffer, int64_t timestampHns,
                               int64_t durationHns);
    bool writeGpuNv12SampleLocked(ID3D11Texture2D* nv12Texture, int64_t timestampHns,
                                  int64_t durationHns);

    static constexpr size_t kGpuNv12PoolSize = 4;

    ComPtr<IMFSinkWriter> sinkWriter_;
    ID3D11Device* device_ = nullptr;
    ID3D11DeviceContext* context_ = nullptr;
    ComPtr<IMFDXGIDeviceManager> dxgiDeviceManager_;
    UINT dxgiResetToken_ = 0;
    ComPtr<ID3D11VideoDevice> videoDevice_;
    ComPtr<ID3D11VideoContext> videoContext_;
    ComPtr<ID3D11VideoProcessorEnumerator> videoProcessorEnum_;
    ComPtr<ID3D11VideoProcessor> videoProcessor_;
    ComPtr<ID3D11Texture2D> gpuNv12Textures_[kGpuNv12PoolSize];
    ComPtr<ID3D11VideoProcessorOutputView> gpuNv12OutputViews_[kGpuNv12PoolSize];
    ComPtr<ID3D11Texture2D> lastGpuFrameTexture_;
    size_t gpuNv12PoolIndex_ = 0;
    bool gpuPipelineEnabled_ = false;
    bool hasLastGpuFrame_ = false;
    ComPtr<ID3D11Texture2D> stagingTexture_;
    ComPtr<ID3D11Texture2D> resizeCompositeTexture_;
    ComPtr<ID3D11RenderTargetView> resizeCompositeView_;
    std::vector<uint8_t> nv12Buffer_;
    std::vector<uint8_t> lastFrameBuffer_;
    DWORD streamIndex_ = 0;
    int width_ = 0;
    int height_ = 0;
    int fps_ = 60;
    int64_t firstSampleTimeHns_ = -1;
    int64_t lastSampleEndTimeHns_ = -1;
    bool initialized_ = false;
    std::mutex mutex_;
};
