// Plain constants shared across the build-promo-timeline pipeline.

export const FPS = 30;
export const SAMPLE_RATE = 48000;
export const AAC_BITRATE = "160k";
// Recorded as timeline.json "voice" (metadata only). variant is the engine
// behind text2speech_v2; speechRate is null because text2speech_v2 takes no
// speech-rate parameter, so none was applied.
export const DEFAULT_VOICE = {
  model: "text2speech_v2",
  variant: "elevenlabs",
  voiceId: "80914268-dfae-4f76-8306-36f2d55f58f8",
  voiceName: "Quinn",
  speechRate: null,
};
