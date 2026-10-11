/**
 * Uptokey TUI — C10 voice-to-code journey.
 *
 * Stitches the existing pieces into one seam: audio → transcription (the
 * core's canonical transcription service, injected here) → editable transcript
 * (TUI overlay; the user always confirms their own words) → the normal coder
 * pipeline through `submit` (the controller's turn path, where proposals,
 * review, W5 and receipts already live).
 *
 * This module owns no capture, no storage and no inference of its own:
 * audio arrives as bytes (from the existing voice capture), transcription and
 * submission are injected, and the review step defaults to pass-through in
 * headless use while the TUI supplies the editable overlay. Nothing is sent
 * anywhere by this file, and no proposal is applied without the canonical
 * review/W5 flow downstream of `submit`.
 */

/** Hard input limits: 60 s of audio at a generous bitrate, still bounded. */
export const VOICE_MAX_BYTES = 6 * 1024 * 1024;

export interface Transcript {
  text: string;
  /** Provider/model identity for the journal (never the audio bytes). */
  provider?: string;
  model?: string;
}

export interface VoiceToCodeDeps {
  /** Canonical transcription (core transcription service in production). */
  transcribe(audio: Uint8Array, signal?: AbortSignal): Promise<Transcript>;
  /**
   * Editable transcript overlay. The user may correct recognition errors
   * before the text becomes a turn; returning null cancels the journey.
   * Default: identity (headless/tests); the TUI supplies the real overlay.
   */
  review?(text: string): Promise<string | null>;
  /** The controller's normal turn submission (coder pipeline, W5 downstream). */
  submit(text: string, signal?: AbortSignal): Promise<unknown>;
}

export interface VoiceToCodeResult {
  /** What the transcriber heard, before user edits. */
  transcript: string;
  /** What was actually submitted after review (null when cancelled). */
  submitted: string | null;
}

export class VoiceToCodeError extends Error {
  code: "voice_audio_empty" | "voice_audio_too_large" | "voice_transcript_empty" | "voice_submission_failed";
  constructor(code: "voice_audio_empty" | "voice_audio_too_large" | "voice_transcript_empty" | "voice_submission_failed") {
    super(code);
    this.name = "VoiceToCodeError";
    this.code = code;
  }
}

export async function voiceToCode(
  deps: VoiceToCodeDeps,
  audio: Uint8Array,
  options?: { signal?: AbortSignal },
): Promise<VoiceToCodeResult> {
  if (!audio || audio.byteLength === 0) throw new VoiceToCodeError("voice_audio_empty");
  if (audio.byteLength > VOICE_MAX_BYTES) throw new VoiceToCodeError("voice_audio_too_large");

  const heard = await deps.transcribe(audio, options?.signal);
  const transcript = (heard.text ?? "").trim();
  if (!transcript) throw new VoiceToCodeError("voice_transcript_empty");

  const reviewed = deps.review ? await deps.review(transcript) : transcript;
  if (reviewed === null) return { transcript, submitted: null };
  const text = reviewed.trim();
  if (!text) return { transcript, submitted: null };

  await deps.submit(text, options?.signal);
  return { transcript, submitted: text };
}
