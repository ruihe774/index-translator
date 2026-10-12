// Registers the page's custom elements. Imported first by app.ts, so they are defined before the
// page looks any of them up.

import { ViewSwitch } from "./view-switch.js";

customElements.define("view-switch", ViewSwitch);
