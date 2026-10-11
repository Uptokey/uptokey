/**
 * J19 (audio slice) — /transcrever on a WAV file of the project: the core prepares a transcription plan, the person
 * approves it, the core's transcription service sends the audio to the speech-to-text endpoint, and the transcript
 * lands in the composer (not sent by itself). Microphone capture, live voice and playback need audio devices and a
 * voice profile, which this automated host does not have; they are reported as not executed, never as passed.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const ENTER = "\r";
const APPROVAL = /Aprovação necessária|Approval required/;

/** One second of 16 kHz mono 16-bit PCM silence in a RIFF/WAVE container. */
function silentWav() {
  const samples = 16000;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export async function voiceJourney({ term, checks, capture, info }) {
  await writeFile(join(info.cwd, "fala.wav"), silentWav());
  // The voice profile adds the "custom" provider; whichever destination is selected, the composer is ready.
  await term.until(() => /Construir · \S+/.test(term.screen()), "composer is not ready", 30000);
  await term.send("/transcrever fala.wav");
  await new Promise((done) => setTimeout(done, 400));
  await term.send(ENTER);
  await term.until(() => APPROVAL.test(term.screen()), "the transcription plan did not ask for approval", 40000);
  checks.transcriptionNeedsApproval = true;
  capture("1. aprovação da transcrição");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Transcrição fixture VOZ_7788"), "the transcript did not reach the composer", 60000);
  checks.transcriptInComposer = true;
  await new Promise((done) => setTimeout(done, 800));
  assert.ok(!term.screen().includes("Resposta do modelo de teste para: Transcrição"), "the transcript was sent by itself");
  checks.notSentByItself = true;
  const sent = await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__transcriptions`)).json();
  checks.transcriptionRequests = sent.map((entry) => ({ bytes: entry.bytes, multipart: /multipart\/form-data/.test(entry.contentType ?? ""), usedStoredCredential: entry.auth === "Bearer fixture_custom_credential_00000000" }));
  assert.equal(sent.length, 1, "the audio was not sent exactly once");
  assert.ok(sent[0].bytes > 32000, "the audio bytes did not reach the endpoint");
  checks.audioSentOnce = true;
  capture("2. transcrição no compositor");
  await term.send(ENTER);
  // Enter submits the transcript as an ordinary request (the destination's own policy then answers or refuses it).
  await term.until(() => /Resposta do modelo de teste para: Transcrição fixture VOZ_7788|Falha no envio/.test(term.screen()), "the transcript was not submitted", 30000);
  checks.sentOnEnter = true;
  checks.turnOutcome = /Falha no envio \(([a-z_]+)\)/.exec(term.screen())?.[1] ?? "answered";
  // Real microphone (the host's input device through ffmpeg/dshow): start, capture for a few seconds, stop; the
  // recording goes through the same approved transcription path and the device is released afterwards.
  if (process.env.UPTOKEY_FFMPEG_PATH) {
    const before = (await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__transcriptions`)).json()).length;
    await term.send("/microfone");
    await new Promise((done) => setTimeout(done, 400));
    await term.send(ENTER);
    await new Promise((done) => setTimeout(done, 400));
    if (/\/microfone/.test(term.screen())) await term.send(ENTER);
    await term.until(() => /Gravando \d+s/.test(term.screen()), "recording is not visible while the microphone is open", 15000);
    checks.recordingVisible = true;
    await new Promise((done) => setTimeout(done, 3000));
    capture("3. microfone gravando");
    checks.micScreen = term.screen().split("\n").filter((line) => /micro|grav|áudio|audio|●|rec/i.test(line)).slice(-3).join(" | ");
    await term.send("/microfone");
    await new Promise((done) => setTimeout(done, 400));
    await term.send(ENTER);
    await new Promise((done) => setTimeout(done, 400));
    if (/\/microfone/.test(term.screen())) await term.send(ENTER);
    for (let i = 0; i < 40 && !APPROVAL.test(term.screen()); i++) await new Promise((done) => setTimeout(done, 500));
    if (APPROVAL.test(term.screen())) await term.send(ENTER);
    await term.until(async () => (await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__transcriptions`)).json()).length > before, "the microphone recording did not reach transcription", 60000);
    const mic = (await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__transcriptions`)).json()).at(-1);
    assert.ok(mic.bytes > 32000, "the microphone recording is empty");
    checks.micRecordingBytes = mic.bytes;
    checks.realMicrophoneCaptured = true;
    capture("4. gravação transcrita");
    await new Promise((done) => setTimeout(done, 1500));
    const { execFileSync } = await import("node:child_process");
    const running = execFileSync("tasklist", ["/FI", "IMAGENAME eq ffmpeg.exe"], { encoding: "utf8" });
    assert.ok(!/ffmpeg\.exe/i.test(running), "the capture process (device) was not released");
    checks.deviceReleased = true;
  }
  checks.notExecutedHere = process.env.UPTOKEY_FFMPEG_PATH ? ["live voice (/voz): needs a realtime voice profile"] : ["microphone capture: no ffmpeg on this host", "live voice (/voz): needs a realtime voice profile"];
}
