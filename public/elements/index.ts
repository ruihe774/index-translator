// Registers the page's custom elements. Imported first by app.ts, so they are defined before the
// page looks any of them up.

import { MetaLine } from "./meta-line.ts";
import { PdfPages } from "./pdf-pages.ts";
import { SpeechControls } from "./speech-controls.ts";
import { ViewSwitch } from "./view-switch.ts";
import { VoiceSettings } from "./voice-settings.ts";

customElements.define("view-switch", ViewSwitch);
customElements.define("speech-controls", SpeechControls);
customElements.define("meta-line", MetaLine);
customElements.define("voice-settings", VoiceSettings);
customElements.define("pdf-pages", PdfPages);
