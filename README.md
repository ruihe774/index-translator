# Index Translator

A local text translator. It runs entirely on your machine, using the Index-Translate 9B models
on your GPU, and does not send your text anywhere.

![Index Translator translating Markdown release notes from English to Chinese. Both sides are shown formatted, and the list the pointer rests on is highlighted on both sides.](docs/screenshot.png)

*A Markdown document translated from English to Chinese. Headings, lists, inline code and emphasis
are kept and shown formatted on both sides. The mouse pointer is on the numbered list in the
source, and the matching list in the translation is highlighted too; a click scrolls the other side
to it.*

## What sets it apart

Compared with widely used online translation tools:

- **Private and offline.** The models run on your own GPU. Your text never leaves your machine, so
  it is safe for confidential documents, and there are no accounts, quotas or fees.
- **Built for whole documents.** A dedicated long-document model translates a full document in one
  pass (Chinese ↔ English, Chinese ↔ Japanese), and the app picks between it and the general model
  by text length.
- **You control the terminology and style.** Give a glossary, hard rules ("keep placeholders
  unchanged"), soft style guidance and a genre such as academic paper or subtitles, and the
  translation follows them.
- **It tells you when something is missing.** Language models can silently drop or repeat
  paragraphs. The app counts paragraphs after each translation and warns you if they differ.
- **Check the result against the original.** When the paragraphs line up, click one on either side
  and the other side scrolls to the matching paragraph.
- **Markdown stays Markdown.** Headings, lists, tables and code blocks in your text are translated
  and shown formatted as they arrive, with a Raw / Preview switch on each side, and Copy gives you
  the Markdown back.
- **Streaming with Stop.** Text appears as it is generated, and you can stop at any time.
- **Reads aloud, locally.** Listen to your text or the translation in Chinese, English, Japanese,
  Spanish or Arabic, with pause, speed and a choice of voices. The speech model (IndexTTS-2.5)
  also runs on your GPU. A Markdown document is read as a document, not as its markup.
- **Correct Chinese and Japanese typography.** Line breaking and fonts follow Japanese and Chinese
  typesetting rules instead of using one font for every language.
- **Accessible.** The interface is checked against WCAG 2.2 AA, including keyboard use and screen
  readers.
- **Scriptable.** A local REST API with streaming is documented in `docs/openapi.yaml`, so other
  programs can use the same translator.

## Start the app

There are two ways to run it: the AppImage, which is one file with everything but the models, or
the source.

Either way you need a GPU with a working Vulkan driver. It was tested on an AMD Radeon RX 9070
(16 GiB). Without a usable GPU, set `GPU_LAYERS=0` to run on the CPU, which is much slower. If
something the app needs is missing (no Vulkan driver, no models yet), it says what and how to get
it, and stops.

### With the AppImage

`Index_Translator-x86_64.AppImage` and `Index_Translator-aarch64.AppImage` are built for every
change: on GitHub, open **Actions**, the latest **CI** run, and download the one for your
processor under **Artifacts** (GitHub hands it out as a zip file; unpack it). The commands below
use the x86-64 name. Then:

```bash
chmod +x Index_Translator-x86_64.AppImage
./Index_Translator-x86_64.AppImage fetch   # once: the models and example voices, about 17.7 GiB
./Index_Translator-x86_64.AppImage         # start; the app opens in your browser
```

Stop the app with `Ctrl+C`. `./Index_Translator-x86_64.AppImage --help` lists the options.

- `fetch` puts the models into `~/.local/share/index-translator` and needs `curl`. An interrupted
  download continues when you run it again. To leave out reading aloud (3.7 GiB):
  `fetch --model index-translate-9b --model index-nailong-9b`. Before it downloads, `fetch` shows each
  model's license and waits for you to type `yes`; the speech model is under bilibili's own license
  with usage conditions, not Apache or MIT. `notices` prints the licenses of the software in the
  AppImage; they are also in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- It runs on x86-64 or aarch64 Linux as new as Ubuntu 24.04 or newer (Debian 13, Fedora 40 and later). Besides
  the Vulkan driver it uses the system's `libgomp` (installed on most systems). Reading aloud needs
  an x86-64 processor with AVX2.

### From the source

```bash
bun src/server.ts
```

Then open **http://127.0.0.1:3000/** in your browser. Stop the app with `Ctrl+C`.

Before the first start, build the engines and get the models once (about 17.7 GiB):

```bash
bun scripts/build_llama.ts      # translation engine (llama.cpp, Vulkan): built from source, 1 to 2 minutes
bun scripts/build_audiocpp.ts   # speech engine (audio.cpp, Vulkan): built from source, 1 to 2 minutes
bun scripts/fetch_models.ts     # the two translation models, the speech and voice separation models, example voices
```

Reading aloud is optional. To leave it out, skip `build_audiocpp.ts` and download only the
translation models with `bun scripts/fetch_models.ts --model index-translate-9b --model index-nailong-9b`.

You need [Bun](https://bun.sh) and `curl`, and to build the engines git, CMake, a C and C++
compiler, `glslc` and the Vulkan headers. On Debian and Ubuntu:
`sudo apt install build-essential git cmake ninja-build glslc libvulkan-dev spirv-headers`.
The translation engine then runs on any x86-64 processor, the speech engine on those with AVX2.

`bun scripts/build_appimage.ts` packs what you have built into an AppImage of your own, in `dist/`.

## Translate text

1. Choose the **From** and **To** languages. Pick **Detect language** if you are not sure of the
   source. Languages include English, Chinese, Japanese, Korean, German, French, Spanish, Russian
   and about 25 more.
2. Paste or type your text into the box.
3. Click **Translate**. The translation appears as it is generated. Click **Stop** to end it early,
   and **Copy translation** to copy the result. **Clear** empties both sides for a new text.

Translation starts only when you click **Translate**; it does not run while you type.

If the text you enter is written in Markdown (headings, lists, code blocks, tables, links and so
on), the translation is shown formatted, as it arrives, and after you click **Translate** your text
is shown formatted too. Each side has **Raw** and **Preview** buttons to switch between the
Markdown source and the formatted view; **Raw** on your side brings back the text box for editing.
**Copy translation** still copies the Markdown source. Links open in a new tab; images are shown as
links and are not loaded.

### Choosing a model

Leave the model on **Automatic** (it picks by text length) unless you have a reason to pick one yourself.
The app then chooses:

- **Index-Translate-9B** for short texts (up to about 11,000 letters) and any language.
- **Index-NativeLong-9B** for longer texts, when the direction is Chinese ↔ English or
  Chinese ↔ Japanese. This model translates a whole document in one pass, but it only handles those
  four directions and does not support glossaries or constraints.
- **Index-Translate-9B** for longer texts in other directions, with a warning that it may drop or
  repeat paragraphs.

### Glossary and constraints

Open **Glossary and constraints** to refine a translation. This works with Index-Translate-9B only.

- **Glossary:** one term per line, as `source term = target term`, for example `模型 = model`.
- **Hard constraints:** rules that must be kept, one per line, for example "keep placeholders
  unchanged".
- **Soft constraints:** style guidance, one per line, for example "formal tone".
- **Genre:** the kind of text, for example `学术论文` (academic paper) or `字幕` (subtitles). It is
  used only together with a glossary or constraints.

In **Automatic** mode, entering any of these makes the app use Index-Translate-9B. If you pick
Index-NativeLong-9B by hand while they are filled in, the app warns that the request cannot be
translated with that model.

## Listen to a text

Each side has a **Listen** button (the loudspeaker) under its text. Click it to hear the source
text or the finished translation. While it reads, the button becomes **Stop**, and a **Pause**
button next to it holds the reading and resumes it at the same place. The paragraph being read is
highlighted in the formatted view.

- **Languages:** Chinese, English, Japanese, Spanish and Arabic. For other languages the button
  is switched off. For the source text, choose its language under **From** if the app cannot tell
  it by itself.
- **Voice and speed:** choose them under **Model and options**. Speed goes from 0.5× to 2×. A
  change while listening takes effect from the sentence being read, which starts again.
- **Voices:** the speech model imitates the speaker of a short recording. Every `.wav` file in the
  `voices` folder (with the AppImage: `~/.local/share/index-translator/voices`) is a voice; the
  download puts the example voices of the IndexTTS demo there. To add your own, put a clean
  recording of a few seconds of speech (one speaker, no music) into the folder and reload the
  page. Only use voices of people who agreed to it.
- **Your own voice sample:** under **Model and options** you can also record or upload a sample.
  It is kept until the app stops. The voice is first taken out of any music and background noise
  by a separation model (BS-RoFormer), which takes a few seconds; the speech model leaves the GPU
  while that runs and is loaded again by the next sentence, which takes about five seconds. Without
  the separation model (`fetch --model bs-roformer`, 0.2 GiB) the sample is used as it is, so a
  clean recording matters then.
- **Markdown:** a text that is shown formatted is read the way it is shown. Headings, list items
  and table rows are read one by one, numbered lists with their numbers, table cells with their
  column heading, links by their text and images by their description. Code blocks are skipped.

The first sentence takes about five seconds longer, because the speech model is loaded when you
first listen. It needs about 5.7 GiB of GPU memory beside the translation model and is unloaded
again after five minutes without listening. Speech is generated sentence by sentence, about four
times faster than it is spoken, so long texts start right away.

Known limits: numbers written in digits are read correctly in Chinese, English, Spanish and
Japanese, but not reliably in Arabic, and unusual formats (for example `$1,200`) may be read
oddly in any language.

## Check long translations

Language models can occasionally drop or repeat paragraphs, and this is not reported as an error.
After each translation, the app compares the number of paragraphs with the source. If they differ,
it shows a warning. When you see one:

- compare the translation with the original, paragraph by paragraph;
- for a long text, try the other model, or split the text into sections and translate each one.

When the counts match, you can click a paragraph on either side to scroll the other side to the
same paragraph. This stops once you edit your text.

The model you use also matters. In testing, Index-NativeLong-9B translated a 30-paragraph English
document to Chinese completely, but Chinese-to-English translation of a full-length document was
not reliable, so check those results carefully.

## Settings

Optional settings are environment variables set before the app starts, or command-line flags
(the lowercase name with dashes: `PORT` is `--port`, `DEFAULT_MODEL` is `--default-model`). A flag
overrides the environment variable:

```bash
PORT=8080 bun src/server.ts
bun src/server.ts --port 8080
./Index_Translator-x86_64.AppImage --port 8080
```

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the app listens on |
| `HOST` | `127.0.0.1` | Address to listen on. The app has no login, so keep it on `127.0.0.1` unless you put it behind a proxy. |
| `DEFAULT_MODEL` | `index-translate-9b` | Model loaded at startup |
| `GPU_LAYERS` | `all` | Layers to run on the GPU; `0` runs on the CPU |
| `LLAMA_THREADS` | half the CPU threads | CPU threads for the engine; matters when running on the CPU |
| `MAX_QUEUE` | `8` | Requests that may wait while another is running. Beyond this, the app reports that the translator is busy. |
| `SPEECH` | on | `0` turns reading aloud off |
| `MODELS_DIR` | `models/`; AppImage: `~/.local/share/index-translator/models` | Folder with the models; `fetch` downloads into it |
| `VOICES_DIR` | `voices/`; AppImage: `~/.local/share/index-translator/voices` | Folder with the voice recordings (`.wav`) |
| `SPEECH_IDLE_UNLOAD` | `300` | Seconds without listening after which the speech model leaves the GPU; `0` keeps it loaded |

Only one translation runs at a time. Other requests wait in line.
