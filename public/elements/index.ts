// Registers the page's custom elements. Imported first by app.ts, so they are defined before the
// page looks any of them up.

import { MetaLine } from "./meta-line.js";
import { SpeechControls } from "./speech-controls.js";
import { ViewSwitch } from "./view-switch.js";
import { VoiceSettings } from "./voice-settings.js";

customElements.define("view-switch", ViewSwitch);
customElements.define("speech-controls", SpeechControls);
customElements.define("meta-line", MetaLine);
customElements.define("voice-settings", VoiceSettings);
