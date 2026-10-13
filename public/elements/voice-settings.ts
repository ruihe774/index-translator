// <voice-settings>: the voice and speed selects and the "Clone a voice" row (upload a file or record
// from the microphone), over the markup in index.html (`#voice`, `#speed`, `#voice-file-button`,
// `#voice-file`, `#voice-record`, `#clone-status`).
//
// It owns what happens in the browser: choosing, picking a file, recording. What needs the server
// stays with the page: the list of voices and uploading a sample. The page hears about it from
// events (`voicechange`, `speedchange`, and `sample` with the audio as picked or recorded, which the
// page turns into a voice) and answers with `setVoices`, `addVoice` and `status`.

import { MicRecorder } from "../voice-sample.ts";

export interface VoiceOption {
  id: string;
  name: string;
}

export interface SampleDetail {
  name: string;
  audio: ArrayBuffer;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class VoiceSettings extends HTMLElement {
  #voice!: HTMLSelectElement;
  #speed!: HTMLSelectElement;
  #file!: HTMLInputElement;
  #record!: HTMLButtonElement;
  #status!: HTMLElement;
  readonly #recorder = new MicRecorder();
  #built = false;

  connectedCallback() {
    if (this.#built) {
      return;
    }
    this.#built = true;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- each call names the element it expects
    const find = <T extends HTMLElement>(selector: string) => {
      const el = this.querySelector<T>(selector);
      if (!el) {
        throw new Error(`<voice-settings> needs ${selector}`);
      }
      return el;
    };
    this.#voice = find("#voice");
    this.#speed = find("#speed");
    this.#file = find("#voice-file");
    this.#record = find("#voice-record");
    this.#status = find("#clone-status");

    this.#voice.addEventListener("change", () => this.dispatchEvent(new Event("voicechange")));
    this.#speed.addEventListener("change", () => this.dispatchEvent(new Event("speedchange")));
    find("#voice-file-button").addEventListener("click", () => this.#file.click());
    this.#file.addEventListener("change", () => void this.#loadFile());
    this.#record.addEventListener("click", () => void this.#toggleRecording());
  }

  async #loadFile(): Promise<void> {
    const file = this.#file.files?.[0];
    this.#file.value = "";
    if (!file) {
      return;
    }
    this.#sample(file.name.replace(/\.[^.]*$/, ""), await file.arrayBuffer());
  }

  /** The selected voice's id; empty when there are none. */
  get voice(): string {
    return this.#voice.value;
  }

  /** Reading speed, 1 for normal. */
  // eslint-disable-next-line @typescript-eslint/related-getter-setter-pairs -- the setter takes the stored option value, the getter the number
  get speed(): number {
    return Number(this.#speed.value);
  }

  /** Selects a speed from the list, as stored; anything not offered is ignored. */
  set speed(speed: string | null) {
    if ([...this.#speed.options].some((o) => o.value === speed)) {
      this.#speed.value = speed as string;
    }
  }

  /** Text under the clone row: progress, the result, or why it failed. */
  // eslint-disable-next-line accessor-pairs -- write-only: the text is shown, never read back
  set status(text: string) {
    this.#status.textContent = text;
  }

  /**
   * Puts the server's voices in the list. The voice selected now stays selected if it is still
   * there, else the remembered one, else the first. True when the selection moved to another voice.
   */
  setVoices(voices: VoiceOption[], remembered: string | null): boolean {
    const before = this.#voice.value;
    const wanted = [before, remembered].find((id) => voices.some((v) => v.id === id));
    this.#voice.replaceChildren(...voices.map((v) => new Option(v.name, v.id)));
    if (wanted) {
      this.#voice.value = wanted;
    }
    return this.#voice.value !== before && this.#voice.value !== "";
  }

  /** Adds a voice that was just uploaded and selects it. */
  addVoice(voice: VoiceOption) {
    this.#voice.append(new Option(voice.name, voice.id));
    this.#voice.value = voice.id;
  }

  #sample(name: string, audio: ArrayBuffer) {
    this.dispatchEvent(new CustomEvent<SampleDetail>("sample", { detail: { name, audio } }));
  }

  async #toggleRecording() {
    const recorder = this.#recorder;
    if (recorder.recording) {
      await this.#finishRecording();
      return;
    }
    if (recorder.starting || recorder.stopping) {
      return;
    } // a permission prompt or a stop is already under way
    this.status = "Waiting for the microphone…";
    try {
      await recorder.start(() => void this.#finishRecording());
    } catch (error) {
      this.status = message(error);
      return;
    }
    this.#record.textContent = "Stop recording";
    this.status = "Recording… speak for 5 to 30 seconds, then stop.";
  }

  async #finishRecording() {
    // Idempotent: the 30 s limit and a click on Stop may both arrive; the first one wins.
    if (!this.#recorder.recording) {
      return;
    }
    this.#record.textContent = "Record";
    let audio: ArrayBuffer;
    try {
      audio = await this.#recorder.stop();
    } catch (error) {
      this.status = message(error);
      return;
    }
    this.#sample(`Recording ${new Date().toLocaleTimeString()}`, audio);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "voice-settings": VoiceSettings;
  }
}
