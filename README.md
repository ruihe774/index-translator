# Index Translator

A local text translator. It runs entirely on your machine, using the Index-Translate 9B models
on your GPU, and does not send your text anywhere.

## Start the app

```bash
bun src/server.ts
```

Then open **http://127.0.0.1:3000/** in your browser. Stop the app with `Ctrl+C`.

Before the first start, download the engine and the models once (about 14 GiB):

```bash
bun scripts/fetch_llama.ts      # translation engine (llama.cpp, Vulkan)
uv run scripts/fetch_models.py  # the two translation models
```

You need [Bun](https://bun.sh), [uv](https://docs.astral.sh/uv/), the C library headers (package
`libc6-dev` on Debian and Ubuntu, `glibc-devel` on Fedora; already there if a C compiler is
installed) and a GPU with a working Vulkan driver. It was tested on an AMD Radeon RX 9070 (16 GiB).
Without a usable GPU, set `GPU_LAYERS=0` to run on the CPU, which is much slower.

## Translate text

1. Choose the **From** and **To** languages. Pick **Detect language** if you are not sure of the
   source. Languages include English, Chinese, Japanese, Korean, German, French, Spanish, Russian
   and about 25 more.
2. Paste or type your text into the box.
3. Click **Translate**. The translation appears as it is generated. Click **Stop** to end it early,
   and **Copy translation** to copy the result.

Translation starts only when you click **Translate**; it does not run while you type.

If the text you enter is written in Markdown (headings, lists, code blocks, tables, links and so
on), the translation is shown formatted, as it arrives. **Copy translation** still copies the
Markdown source. Links open in a new tab; images are shown as links and are not loaded.

### Choosing a model

Leave the model on **Automatic (by text length)** unless you have a reason to pick one yourself.
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

## Check long translations

Language models can occasionally drop or repeat paragraphs, and this is not reported as an error.
After each translation, the app compares the number of paragraphs with the source. If they differ,
it shows a warning. When you see one:

- compare the translation with the original, paragraph by paragraph;
- for a long text, try the other model, or split the text into sections and translate each one.

The model you use also matters. In testing, Index-NativeLong-9B translated a 30-paragraph English
document to Chinese completely, but Chinese-to-English translation of a full-length document was
not reliable, so check those results carefully.

## Settings

Optional settings are environment variables set before the app starts:

```bash
PORT=8080 bun src/server.ts
```

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the app listens on |
| `HOST` | `127.0.0.1` | Address to listen on. The app has no login, so keep it on `127.0.0.1` unless you put it behind a proxy. |
| `DEFAULT_MODEL` | `index-translate-9b` | Model loaded at startup |
| `GPU_LAYERS` | `all` | Layers to run on the GPU; `0` runs on the CPU |
| `LLAMA_THREADS` | half the CPU threads | CPU threads for the engine; matters when running on the CPU |
| `MAX_QUEUE` | `8` | Requests that may wait while another is running. Beyond this, the app reports that the translator is busy. |

Only one translation runs at a time. Other requests wait in line.
