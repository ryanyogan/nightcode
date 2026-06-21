# nightcode — A Deep Architectural Walkthrough

> Written for someone fluent in React-on-the-web who has **not** worked much with
> terminals, byte streams, or text encoding. Nothing here assumes you've seen
> streaming before. We build that idea up from scratch in Part 3.

---

## Table of contents

1. [The 30,000-foot view](#1-the-30000-foot-view)
2. [How React renders into a terminal (OpenTUI)](#2-how-react-renders-into-a-terminal-opentui)
3. [Streaming from absolute first principles](#3-streaming-from-absolute-first-principles) ← the big one
4. [The end-to-end lifecycle of one message](#4-the-end-to-end-lifecycle-of-one-message)
5. [The provider stack, in depth](#5-the-provider-stack-in-depth)
6. [The keyboard-layer system, in depth](#6-the-keyboard-layer-system-in-depth)
7. [The server, in depth](#7-the-server-in-depth)
8. [The database layer](#8-the-database-layer)
9. [End-to-end type safety (the Hono RPC trick)](#9-end-to-end-type-safety-the-hono-rpc-trick)
10. [File-by-file reference](#10-file-by-file-reference)
11. [Quirks, gotchas, and unfinished edges](#11-quirks-gotchas-and-unfinished-edges)

---

## 1. The 30,000-foot view

nightcode is an **AI coding assistant that runs in your terminal** — think
Claude Code / Cursor's chat, but as a TUI (Text User Interface). The single most
important thing to internalize:

> **It is built like a normal React web app.** Components, hooks, `useState`,
> context providers, `react-router`, a `fetch`-based API client, a separate HTTP
> backend. The *only* fundamental difference from web React is the renderer:
> output goes to the **terminal** instead of the **DOM**.

It's a **Bun monorepo** with four workspace packages:

```
packages/
  cli/        ← the React terminal app  (the "frontend")
  server/     ← a Hono HTTP API         (the "backend")
  shared/     ← types, model list, zod schemas (imported by both)
  database/   ← Prisma + PostgreSQL      (persistence)
```

The runtime is **Bun** (not Node) — that matters because Bun ships a lot of
web-standard APIs natively (`fetch`, `ReadableStream`, `TextDecoderStream`,
`crypto.randomUUID`), which is why you'll see browser-style streaming code
running in a CLI.

The data path for a single AI reply:

```
 you type ──► <textarea> ──► useChat.submit()
   │
   │ HTTP POST (typed Hono client)
   ▼
 server route /chat/:sessionId
   │  ├─ writes your USER message to Postgres (Prisma)
   │  └─ calls the model via the Vercel AI SDK (streamText)
   │
   │  Server-Sent Events (SSE): a long-lived HTTP response that
   │  dribbles out tiny JSON events as the model produces tokens
   ▼
 useChat reads the stream, appends text delta-by-delta,
 re-renders the live "assistant is typing" bubble each tick
   │
   ▼
 on "done": server has saved the final ASSISTANT message,
 client swaps the live bubble for a permanent message
```

---

## 2. How React renders into a terminal (OpenTUI)

You know that on the web, `react-dom` is the thing that takes your JSX tree and
mutates the browser DOM. React itself is **renderer-agnostic** — the core
"reconciler" (the diffing engine) is separate from the thing that actually
paints pixels. React Native uses this to paint native views; Ink and OpenTUI use
it to paint terminals.

This app uses **`@opentui/react`**. In `packages/cli/src/index.tsx`:

```tsx
const renderer = await createCliRenderer({ targetFps: 60, exitOnCtrlC: false });
createRoot(renderer).render(<App />);
```

- `createCliRenderer` sets up a render loop that repaints the terminal up to 60
  times a second. A terminal is just a 2D grid of character cells, each with a
  foreground color, background color, and attributes (bold/dim). OpenTUI
  maintains a virtual representation of that grid and writes the minimal escape
  sequences to update it — conceptually the same "virtual DOM diff → minimal
  real mutations" idea as the web, but the "real DOM" is a character grid.
- `createRoot(...).render(...)` is the exact same API shape as
  `react-dom/client`.
- `exitOnCtrlC: false` is deliberate — the app wants to intercept Ctrl-C itself
  (see Part 6) instead of letting the terminal kill the process.

### The intrinsic elements ("host components")

On the web your JSX leaves are `div`, `span`, `input`. Here they're terminal
primitives (all lowercase, so TypeScript treats them as intrinsic host
elements):

| Element | Web analogy | Notes |
|---|---|---|
| `<box>` | `<div>` | **Full flexbox**: `flexDirection`, `gap`, `padding`, `justifyContent`, `position="absolute"`, `zIndex`, `border`. Yoga layout engine under the hood. |
| `<text>` | `<span>` / text node | Has `fg`, `attributes` (`TextAttributes.BOLD`/`DIM`), `wrapMode`. Text **must** live inside `<text>`; you can't drop a raw string into a `<box>`. |
| `<textarea>` | `<textarea>` | Multi-line editable. Exposes an imperative handle (`.plainText`, `.setText()`, `.insertText()`, `.onSubmit`). |
| `<input>` | `<input>` | Single-line. Used in the dialog search list. |
| `<scrollbox>` | scrollable `<div>` | Has a `viewport`, `scrollTop`, `.scrollTo()`. Supports `stickyScroll` (pin to bottom — exactly what a chat log wants). |
| `<spinner>` | — | From `opentui-spinner`. Animated. |
| `<ascii-font>` | — | Renders big ASCII-art text (the "Chroma code" header). |

Layout values like `width="100%"`, `maxWidth={70}`, `flexGrow={1}` behave like
CSS flexbox. So `components/header.tsx` centering a logo is conceptually
identical to a web flex container.

Styling is just props — there's no CSS file. Colors come from the theme context
(Part 5) and are passed down as hex strings or `RGBA` objects.

**Imperative refs are more common here than on the web.** Because a `<textarea>`
in a terminal manages its own cursor and buffer, the app reaches for
`textAreaRef.current.plainText` and `.setText("")` directly (see
`components/input-bar.tsx`) rather than the controlled-component pattern you'd
use with React on the web. This is normal in TUI land.

---

## 3. Streaming from absolute first principles

This is the part that's new to you, so we start from "what even *is* text" and
build all the way up to the exact pipeline this app uses. Take your time here.

### 3.1 What a computer means by "text"

A computer only stores **bytes** — numbers from 0 to 255. "Text" is a convention
for mapping bytes to characters.

- **ASCII** (the old way): one byte = one character. `A` = 65, `a` = 97, `!` =
  33. Only covers English-ish characters (0–127).
- **Unicode** is the modern universal catalog. Every character — `A`, `é`, `字`,
  `🔥`, `→` — has a number called a **code point** (e.g. `🔥` is U+1F525 =
  128293). There are ~150,000 of them, far more than fit in a single byte.
- **UTF-8** is the dominant way to *encode* those code points into bytes. It's a
  **variable-length** encoding:
  - ASCII characters (`A`, `1`, space) → **1 byte**.
  - Most Latin-with-accents, Greek, Cyrillic → **2 bytes**.
  - Most other languages (Chinese, Japanese, etc.) → **3 bytes**.
  - Emoji and rare symbols → **4 bytes**.

So the single emoji `🔥` is the four bytes `F0 9F 94 A5`. **The number of bytes
is not the number of characters.** Remember this — it's the reason one specific
piece of plumbing in this app exists (§3.8).

Two helpers convert between the two worlds:

- `TextEncoder` : characters → bytes (UTF-8).
- `TextDecoder` : bytes → characters.

### 3.2 The normal request/response model (what you already know)

When you do `await fetch(url)` on the web and then `await res.json()`, here's
what happens conceptually:

1. Your machine opens a connection and sends an HTTP request.
2. The server does its work, produces the **entire** response body, and sends it.
3. Your client **waits until the last byte arrives**, collects all the bytes into
   memory, decodes them to text, and `JSON.parse`s the whole thing.

This is **buffer-the-whole-thing-then-hand-it-over**. It's perfect for "give me
this user record." The defining property: *you get nothing until everything is
ready.*

### 3.3 Why that model is bad for an LLM

A language model generates text **token by token** (a token ≈ a few characters).
A long answer might take 30+ seconds to finish. With the buffer-everything model,
the user would stare at a blank screen for 30 seconds and then get a wall of text
all at once. Awful.

What we want instead: show each piece **the instant the model produces it**, like
a person typing. To do that, the HTTP response must stay **open** and the server
must be able to **push out little pieces over time** while the client reads them
**as they arrive**. That is **streaming**.

The mental shift:

```
Classic:    [============ wait ============] then WHOLE body at once
Streaming:  [piece][piece][piece][piece][piece]...[done]  arriving over time
```

### 3.4 Chunks

A **chunk** is just "a piece of the body that arrived together." When data
streams over a network, the operating system and the network hand it to your
program in arbitrary-sized installments. You do **not** control where the splits
happen. A chunk is whatever showed up since you last looked.

Critically, **chunk boundaries are meaningless to your application.** The network
might give you:

```
chunk 1: '{"type":"text-delta","te'
chunk 2: 'xt":"Hel'
chunk 3: 'lo"}\n\n{"type":"text-delta"...'
```

The network split that first JSON object right down the middle. It split it
mid-word. It might even split it mid-emoji (mid-multibyte-character). Your job is
to **reassemble** the meaningful units out of this stream of dumb byte pieces.
That reassembly is what "buffering" and "parsing" are about, and it's most of
what §3.7–3.9 do.

### 3.5 Buffers (and why you need them)

A **buffer** is a temporary holding area where you accumulate bytes/text until
you have *enough to do something useful with*.

Because chunks arrive split at random points, a streaming parser keeps a buffer
like this:

```
loop:
  chunk arrives  ──►  append chunk to buffer
                      can I pull a complete unit (a full event/line) out of the buffer yet?
                        yes ─► emit it, remove it from the buffer, check again
                        no  ─► keep the partial bytes in the buffer, wait for more
```

That's the universal pattern for parsing any stream: **append, try to extract
complete units, keep the leftover remainder for next time.** You'll see this
exact shape twice in this app's pipeline — once for *bytes → characters*, once
for *characters → events*.

### 3.6 The transport: Server-Sent Events (SSE)

There are a few ways to stream over HTTP. This app uses **SSE (Server-Sent
Events)**, which is the simplest: it's an ordinary HTTP response with
`Content-Type: text/event-stream` that the server **keeps open** and writes a
specific tiny text format into.

The SSE wire format is just UTF-8 text with this shape, one "event" at a time:

```
event: text-delta
data: {"type":"text-delta","text":"Hello"}

event: text-delta
data: {"type":"text-delta","text":" world"}

event: done
data: {"type":"done","messageId":"abc","durationMs":1234}

```

Rules of the format:
- Each line is `field: value`.
- The fields used here are `event:` (a name/label) and `data:` (the payload —
  here a JSON string).
- **A blank line terminates one event.** That double-newline (`\n\n`) is the
  delimiter. This is the "complete unit" boundary the parser looks for.

SSE is one-directional (server → client only) and text-only, which is exactly
what an LLM token stream needs. (The alternative, WebSockets, is bidirectional
and binary-capable but much heavier; overkill here.)

### 3.7 The Web Streams API: `ReadableStream` and async iteration

When you `await fetch(...)`, the returned `response.body` is a
**`ReadableStream`** — an object representing "bytes that will arrive over time."
It is a stream of **`Uint8Array`** chunks (raw bytes, §3.1), *not* text yet.

Two ways to consume a `ReadableStream`:

1. **Manually**, with a reader and a loop:
   ```ts
   const reader = response.body.getReader();
   while (true) {
     const { value, done } = await reader.read(); // value is a Uint8Array chunk
     if (done) break;
     // ...handle bytes...
   }
   ```
2. **By piping it through transforms**, which is what this app does (cleaner):
   ```ts
   const stream = response.body
     .pipeThrough(new TextDecoderStream())          // bytes  → text
     .pipeThrough(new EventSourceParserStream());    // text   → parsed SSE events

   for await (const event of stream) {
     // event is a fully-formed SSE event object
   }
   ```

`.pipeThrough(transform)` is like Unix pipes (`cat | grep | sort`): each stage
takes the previous stage's output stream and produces a new transformed stream.
A **`TransformStream`** is exactly a chunk-in → chunk-out converter that
*maintains its own internal buffer* (§3.5) across chunks.

`for await (... of stream)` is JavaScript's syntax for "pull items out of an
async source one at a time, awaiting each." Each loop iteration runs the moment
the next item is available, then suspends until the one after that — this is the
"react as pieces arrive" behavior from §3.3, expressed as a plain `for` loop.

### 3.8 Stage 1 of the pipe: `TextDecoderStream` (bytes → characters)

This is where §3.1 pays off. The raw stream gives you **bytes** in arbitrary
chunks. You can't just call `String.fromCharCode` on each chunk, because a chunk
can **end in the middle of a multi-byte character.**

Remember `🔥` = `F0 9F 94 A5` (4 bytes). The network might hand you:

```
chunk A: ...some text... F0 9F      ← first 2 bytes of the fire emoji
chunk B: 94 A5 ...more text...       ← last 2 bytes
```

If you decoded each chunk independently, chunk A ends with two bytes that are
**half a character** — garbage (you'd get a `�` replacement character), and chunk
B would start with two orphaned bytes — more garbage.

`TextDecoderStream` solves this by buffering (§3.5) at the byte level: when a
chunk ends mid-character, it **holds the incomplete trailing bytes** and prepends
them to the next chunk before decoding. Output: clean, correctly-decoded text
strings, with no character ever split. You get out a stream of **text chunks**
(`string`), still arbitrarily sized, but never broken mid-character.

This is one of those things you'd never think about until it corrupts every 50th
emoji in production. The standard library handles it so the app doesn't have to.

### 3.9 Stage 2 of the pipe: `EventSourceParserStream` (text → events)

Now we have a stream of text chunks, but a text chunk is *still* not an event —
remember from §3.4 a single SSE event might be split across chunks, or several
events might arrive in one chunk. This stage (from the `eventsource-parser`
package) does the §3.5 buffer dance at the **text/line level**:

- It appends incoming text to its internal buffer.
- It scans for the SSE delimiters (newline-separated `field: value` lines, blank
  line = end of event).
- Every time it has a **complete** event, it emits a clean object like
  `{ event: "text-delta", data: '{"type":"text-delta","text":"Hello"}' }`.
- Any trailing partial event stays in the buffer until more text arrives.

After this stage, `for await` finally yields **whole SSE events**, one per
iteration. The `.data` field is still a JSON *string* — the app does
`JSON.parse(data)` and then validates it with a zod schema before trusting it.

### 3.10 The full client pipeline, annotated

From `packages/cli/src/hooks/use-chat.ts`, this is the real code with the §3.7–3.9
stages labeled:

```ts
const stream = response
  .body!                                   // ReadableStream<Uint8Array>  (raw bytes)
  .pipeThrough(new TextDecoderStream())    // → ReadableStream<string>    (clean text, §3.8)
  .pipeThrough(new EventSourceParserStream()); // → stream of SSE events  (§3.9)

for await (const { data } of stream) {     // one whole event per iteration (§3.7)
  // guard: ignore if this stream was superseded by a newer request (§4 / staleness)
  if (!isActiveRequest(activeStream.requestId)) return;

  let event;
  try {
    event = chatStreamEventSchema.parse(JSON.parse(data)); // string → object → validated (§3.9)
  } catch {
    // malformed/unknown payload → surface an error bubble and stop
    break;
  }

  switch (event.type) {
    case "text-delta": {
      // append this token to the in-progress assistant text…
      const last = parts[parts.length - 1];
      if (last && last.type === "text") last.text += event.text;
      else parts.push({ type: "text", text: event.text });
      emitParts(activeStream.requestId, parts); // …and re-render the live bubble
      break;
    }
    case "done": {
      // model finished: build the final message, append it, retire the live bubble
      break;
    }
    case "error": {
      // server sent a structured error event
      break;
    }
  }
}
```

Notice the layering: **bytes → characters → events → app meaning**, each layer
buffering its own kind of "incomplete unit." That is the entire essence of stream
processing. Once this clicks, every streaming system you ever meet is a variation
on it.

### 3.11 The server side of the same stream

`packages/server/src/routes/chat.ts` produces what the client consumes. Hono's
`streamSSE(c, async (stream) => { ... })` opens the long-lived response and gives
you a `stream` with `.writeSSE({ event, data })`. The model's output is itself a
stream (the Vercel AI SDK's `streamText(...).fullStream`), so the server is
**piping one stream into another**:

```ts
const result = streamText({ model: resolvedModel.model, messages: history, abortSignal });

let fullText = "";
for await (const part of result.fullStream) {   // model emits parts over time
  if (stream.aborted) return;                    // client hung up → stop early
  if (part.type === "text-delta") {
    fullText += part.text;                        // accumulate the full answer (for DB)
    await stream.writeSSE({                        // forward this token to the client
      event: "text-delta",
      data: JSON.stringify({ type: "text-delta", text: part.text }),
    });
  }
  if (part.type === "error") throw part.error;
}
// loop ended cleanly → persist the COMPLETE assistant message, then send "done"
```

So the server is a **relay**: model-stream → SSE-stream, while also accumulating
`fullText` so it can save the finished message to Postgres at the end.

### 3.12 Backpressure (the concept the streams API quietly handles for you)

One more idea worth naming. What if the model produces text faster than the
network can ship it, or faster than the terminal can render it? Without
coordination you'd pile up unbounded data in memory.

**Backpressure** is the built-in feedback that says "the consumer is busy, slow
down." The Web Streams API (`pipeThrough`, `for await`) propagates this
automatically: if your `for await` body is slow, the stream stops pulling more
from upstream until you're ready. You don't write any code for it here — but it's
*why* piping streams is safer than manually buffering everything yourself, and
worth knowing the word for.

### 3.13 Interrupting a stream (`AbortController`)

Streaming introduces a question request/response never had: *how do you stop
something that's still arriving?* The answer is the **`AbortController`** — a web
standard "cancel button."

- You create `const controller = new AbortController()`.
- You pass `controller.signal` into the operation (`fetch`, or the AI SDK's
  `abortSignal`).
- Calling `controller.abort()` makes the in-flight operation reject/stop.

In `use-chat.ts`, each active stream owns a controller. Pressing **Esc** while
streaming calls `interrupt()` → `stopActiveStream(true)`, which:
1. Captures whatever partial text arrived so far as a real (interrupted) message,
   so you don't lose it.
2. Sets streaming state back to idle.
3. Calls `controller.abort()`.

The abort signal travels all the way to the server: Hono's `stream.onAbort(...)`
fires, which aborts the **server's** `AbortController`, which stops the model
stream — and the server persists the partial reply with status `INTERRUPTED`. So
one Esc cleanly tears down the whole chain: terminal → HTTP → model.

---

## 4. The end-to-end lifecycle of one message

Let's trace a brand-new conversation from keystroke to saved reply, naming every
file. This stitches Parts 2–3 together.

**A. Home screen** (`screens/home.tsx`)
You type into the `InputBar` and hit Enter. `handleSubmit` runs
`navigate("/sessions/new", { state: { message: text } })`. (react-router's
in-memory router — `state` is how it passes data between routes without a URL
param.)

**B. Create the session** (`screens/new-session.tsx`)
On mount it reads `location.state`, validates it with zod, and (guarded by a
`hasStartedRef` so it only fires once even under React 19's double-invoked
effects) calls:

```ts
apiClient.sessions.$post({ json: { title, cwd, initialMessage: {...} } })
```

The server (`routes/sessions.ts`) creates a `Session` row + the first `USER`
`Message` row in Postgres and returns the session including its messages. The
screen then `navigate`s to `/sessions/:id`, passing the fresh session object in
route `state` so the next screen doesn't have to re-fetch (a "prefetch handoff").

**C. Session screen** (`screens/session.tsx`)
Reads the prefetched session from `location.state` (falling back to a GET by id
if you deep-linked). It maps the DB message rows into the client `Message` shape
(`mapDBMessages`) and mounts `<SessionChat>`. Note the `key={session.id}` — it
forces a fresh component instance per session so chat state never leaks between
sessions.

**D. The chat hook kicks in** (`hooks/use-chat.ts`)
`SessionChat` calls `useChat(sessionId, initialMessages)`. There's an effect:
"if the last message is an unanswered `USER` message, automatically start
streaming a reply." Since we just created the session with exactly one user
message, this **auto-fires** `resume(...)` → `runStream(...)`. This is why the
assistant starts typing immediately after you create a session, without you doing
anything else.

**E. The request + stream** (`use-chat.ts` → `routes/chat.ts`)
`runStream` makes an `AbortController`, records an `activeStream` (with a unique
`requestId`), sets `streaming` state to `"streaming"`, and POSTs. The server
(`/chat/:sessionId/resume` here, or `/chat/:sessionId` for follow-ups) loads the
session history, builds the model's message array (`buildConversationHistory`
drops empty/error messages), calls `streamText`, and relays tokens as SSE (Part
3.11). The client reads them (Part 3.10) and re-renders the live `<BotMessage
streaming>` bubble on every `text-delta`.

**F. Completion**
Server saves the final `ASSISTANT` message (status `COMPLETE`, with a `duration`)
and writes a `done` event carrying the real DB `messageId` and `durationMs`. The
client appends the finished message to `messages[]` **and** clears the live
bubble *in the same tick* (the code comments call this out specifically — so the
finished message and the live bubble never both show for one frame, which would
flicker a duplicate).

**G. Follow-up messages**
Now you type again. `SessionChat`'s `onSubmit` → `submit(...)`, which first calls
`stopActiveStream(true)` (cancel anything in flight, keep partials), optimistically
appends your `USER` message to the UI, then POSTs to `/chat/:sessionId`. The
server writes your user message, rebuilds history including it, and streams the
reply. Same machinery as before.

### The staleness guard (why `requestId` exists)

Streaming + React is racy: a slow response can resolve *after* you've already
started a newer one, and naïvely it would corrupt the new stream's UI. The hook
defends against this with `activeStreamRef` holding the **one** current
`requestId`. Every callback checks `isActiveRequest(requestId)` before touching
state; a superseded stream's events are silently dropped. This is the streaming
equivalent of the classic "ignore stale fetch" `let ignore = false` cleanup
pattern you've probably written on the web — here it's done with an id because
there's an imperative stream to also tear down.

---

## 5. The provider stack, in depth

All screens render inside a nested provider stack defined in
`layouts/root-layout.tsx`. Order matters because inner providers consume outer
ones (e.g. `DialogProvider` uses the keyboard layer; everything uses the theme):

```
ThemeProvider
 └ KeyboardLayerProvider
    └ ToastProvider
       └ DialogProvider
          └ PromptConfigProvider
             └ ThemedRoot  →  <Outlet/>   (the routed screen)
```

Each provider is the textbook React pattern: a `createContext`, a `Provider` with
`useState`/`useCallback`/`useMemo`, and a `useX()` hook that throws if used
outside its provider. If you've written React context on the web, there is
**zero** new API here. The interesting parts are *what* they manage.

### ThemeProvider — `providers/theme/index.tsx`
- Holds the active `Theme` (a name + a `ThemeColors` object). The 30+ themes live
  in `theme.ts` (Nightfox is the default).
- **Persistence**: on change it writes `{ themeName }` to
  `~/.config/.dooeycode/config.json` using Node's `fs`. On startup
  `getInitialTheme()` reads that file (falling back to default if missing/corrupt).
  This is the TUI version of `localStorage` — a real file on disk.
- Everything calls `useTheme().colors` to style itself, so changing the theme
  re-renders the whole tree with new colors instantly.

### ToastProvider — `providers/toast/index.tsx`
- `useToast().show({ variant, message, duration? })`. Holds a single current
  toast and a `setTimeout` handle.
- Renders one absolutely-positioned, top-right notification box, colored by
  variant (`success`/`error`/`info` from the theme). Auto-dismisses; `show`
  clears any existing timer first so a new toast resets the clock.
- Detail: `.unref()` on the timer so a pending toast timeout can't keep the
  process alive on exit.
- Used mostly for surfacing request failures (e.g. "Failed to create session").

### DialogProvider — `providers/dialog/index.tsx`
- `useDialog().open({ title, children })` / `.close()`. Holds one current dialog
  config; renders a **full-screen modal overlay** (`position="absolute"`,
  full width/height, dimmed backdrop via `RGBA.fromInts(0,0,0,150)`,
  `zIndex={100}`), with a centered card.
- **Integrates with the keyboard layer**: `open` calls `push("dialog", ...)` and
  `close` calls `pop("dialog")`, so while a dialog is open it "owns" the keyboard
  (Part 6). The dialog's own `useKeyboard` only reacts to Esc when
  `isTopLayer("dialog")` is true.
- Clicking the dimmed backdrop closes it; clicking the card calls
  `e.stopPropagation()` so the click doesn't bubble to the backdrop. (Yes,
  terminals have mouse events — `onMouseDown`, `onMouseMove`.)
- Dialog *content* is injected as `children`, so the provider is generic. The
  concrete dialogs (`components/dialogs/*`) supply content: pick a model, pick an
  agent/mode, browse sessions, pick a theme.

### PromptConfigProvider — `providers/prompt-config/index.tsx`
- Holds the two settings that decorate every outgoing message:
  - `mode`: `BUILD` vs `PLAN` (a Prisma enum). `toggleMode()` flips it; **Tab**
    in the input bar calls it.
  - `model`: a `SupportedChatModelId` (default `gpt-5.5`). The `/models` dialog
    sets it.
- Consumed by `StatusBar` (shows "Build > gpt-5.5"), the `Spinner` (color), and
  `BotMessage` (the little metadata line under each reply).

---

## 6. The keyboard-layer system, in depth

This is the one genuinely non-web concept, so here's the *why* before the *how*.

**The problem.** On the web, the browser gives you focus and event bubbling for
free — a keystroke goes to the focused element and stops. In a terminal there is
**one global stream of keypresses**, and *every* component that calls
`useKeyboard(...)` hears *every* key. With several components listening, pressing
`Esc` could simultaneously: close a dialog, clear the textarea, and interrupt the
stream. You need a way to decide "who owns the keyboard right now."

**The solution** (`providers/keyboard-layer/index.tsx`): a **stack of named
layers**, like z-index but for keyboard ownership.

```ts
const [stack, setStack] = useState<string[]>(["base"]);
```

The stack might be `["base"]`, then `["base", "command"]` when you open the slash
menu, then `["base", "command", "dialog"]` if a dialog opens on top. The API:

- `push(id, responder?)` — add a layer (when a UI element that wants keyboard
  ownership appears). Idempotent (won't double-add).
- `pop(id)` — remove it (when that element closes).
- `isTopLayer(id)` — **the gatekeeper**. Components wrap their key handlers in
  `if (!isTopLayer("base")) return;`. Only the top layer reacts. Example from
  `input-bar.tsx`:
  ```ts
  useKeyboard((key) => {
    if (!isTopLayer("base")) return;   // a dialog/menu is open → ignore keys
    if (key.name === "tab") { key.preventDefault(); toggleMode(); }
  });
  ```
- `setResponder(id, fn)` — register a per-layer **Ctrl-C handler** (the "responder
  chain", below).

### The Ctrl-C responder chain (the elegant bit)

Because `exitOnCtrlC` is off, the provider has the **only** global Ctrl-C
listener:

```ts
useKeyboard((key) => {
  if (!key.ctrl || key.name !== "c") return;
  // walk layers top → bottom, offer each a chance to handle it
  for (let i = stack.length - 1; i >= 0; i--) {
    const responder = responders.current.get(stack[i]);
    if (responder && responder()) return;  // handled → consume, stop
  }
  renderer.destroy();                        // nobody handled it → quit the app
});
```

Each layer registers what Ctrl-C should mean *for it*, returning `true` to "I
handled it, stop here":

- The **`base`** responder (set in `input-bar.tsx`): "if the textarea has text,
  clear it and consume the keypress" → first Ctrl-C clears your input.
- The **`dialog`** responder (set in `dialog/index.tsx`): "close me and consume."
- If no layer consumes it, the loop falls through to `renderer.destroy()` →
  the app exits.

Net effect: Ctrl-C does the **contextually correct** thing — clear input, else
close the open dialog, else quit — and you never have to special-case it at each
call site. It's a clean, composable solution to a problem the web hands you for
free.

### Where the layers come from
- `"base"` — always present (the main input bar). Bottom of the stack.
- `"command"` — pushed by `use-command-menu.ts` when you type `/`, popped on
  select/Esc.
- `"dialog"` — pushed by `DialogProvider.open`, popped on close.

The `<textarea focused={... isTopLayer("base") || isTopLayer("command")}>` line in
`input-bar.tsx` shows the layer system also driving *focus*: the textarea keeps
input focus while either the base layer or the command menu is on top, but yields
when a dialog takes over.

---

## 7. The server, in depth

`packages/server` is a **Hono** app. Hono is a tiny, web-standard
(`Request`/`Response`) HTTP framework — think Express but built on Fetch APIs, so
the same code runs on Bun, Workers, Deno, etc.

### `src/index.ts` — the app shell
```ts
const routes = app.route("/sessions", sessions).route("/chat", chat);
export type AppType = typeof routes;       // ← exported for the typed client (Part 9)
export default { port: 3000, fetch: app.fetch, idleTimeout: 255 };
```
- Mounts the two route groups.
- A global `app.onError` turns `HTTPException`s into `{ error }` JSON and
  everything else into a 500. (The client's `getErrorMessage` in
  `lib/http-errors.ts` reads that `{ error }` shape back out.)
- `idleTimeout: 255` (seconds) is bumped high **because SSE responses stay open a
  long time** — a default short idle timeout would kill long streams.
- `export type AppType` is the linchpin of end-to-end types (Part 9).

### `src/routes/sessions.ts` — CRUD
- `GET /sessions` — list (id, title, createdAt), newest first.
- `GET /sessions/:id` — one session with all messages (ascending).
- `POST /sessions` — validates the body with a zod schema via
  `@hono/zod-validator`, creates the session (+ optional initial message) in one
  Prisma call, returns 201. (`userId` is hardcoded `"mock-user"` — no auth yet.)

### `src/routes/chat.ts` — the streaming brain
Two endpoints, both returning SSE via `streamSSE`:

- `POST /chat/:sessionId` — normal turn. Validates `{ content, mode, model }`,
  writes the `USER` message, rebuilds history (now including it), streams the
  reply.
- `POST /chat/:sessionId/resume` — finish a dangling user message (the auto-fire
  path from Part 4D). It guards against double-resume with a module-level
  `Set<string>` of `activeResumeSessionIds`, and returns `409` if the last
  message isn't a resumable user message or the session is already resuming.

The shared `streamAIResponse(...)` is the relay from Part 3.11. Key behaviors:
- Accumulates `fullText` as it forwards `text-delta`s.
- On clean finish → save `ASSISTANT`/`COMPLETE` with a `duration` (seconds), send
  `done` with the new DB id + `durationMs`.
- On abort (client hung up / Esc) → `persistInterruptedMessage()` saves what it
  had as `INTERRUPTED` (or nothing if empty).
- On error → save an `ERROR` message and emit an `error` SSE event so the client
  can render an error bubble.

### `src/lib/models.ts` — provider resolution
Maps a model id string to a real Vercel-AI-SDK model object. It branches on
`provider` (`anthropic(id)` vs `openai(id)`) and uses an
`assertUnsupportedProvider(provider: never)` exhaustiveness check — if someone
adds a third provider to the shared list and forgets to handle it here,
**TypeScript fails the build.** `isSupportedChatModel` is a type guard used by the
zod validators so unknown model ids are rejected at the edge.

---

## 8. The database layer

`packages/database` wraps **Prisma** over **PostgreSQL**.

- `prisma/schema.prisma` defines three enums (`Role`, `Mode`, `MessageStatus`)
  and two models:
  - **`Session`** — `id`, `userId`, `title`, optional `cwd` (the working
    directory the session was started in), `createdAt`, and a `messsages[]`
    relation. *(Yes, "messsages" is misspelled with three s's — consistently,
    everywhere, so it works; just don't "fix" one spot and break the build.)*
  - **`Message`** — `id`, `sessionId`, `role`, `status`, `model`, `content`,
    optional `parts` (JSON, reserved for richer structured content), `mode`,
    optional `duration` (seconds), `createdAt`. `onDelete: Cascade` so deleting a
    session removes its messages. Indexed on `sessionId`.
- `src/client.ts` loads `DATABASE_URL` from the repo-root `.env`, creates a
  `PrismaPg` adapter, and exports a singleton `db`. Throws loudly if the URL is
  missing.
- `src/index.ts` / `src/enums.ts` re-export the generated client + enums so the
  rest of the monorepo imports `@nightcode/database` and `@nightcode/database/enums`
  rather than reaching into the generated folder.

The `parts` JSON column plus the richer `messagePartSchema` in shared (which
already models `reasoning` and `tool-call` parts) signal where this is heading:
multi-part assistant messages with tool calls and visible reasoning. Today only
plain `text` parts are actually produced.

---

## 9. End-to-end type safety (the Hono RPC trick)

This is a highlight worth understanding because it's why the client/server feel
like one program.

- The server does `export type AppType = typeof routes;` — a **type** describing
  every route, its params, its validated body, and its response shape.
- The client (`cli/src/lib/api-client.ts`) does:
  ```ts
  import { hc } from "hono/client";
  import type { AppType } from "@nightcode/server";
  export const apiClient = hc<AppType>(process.env.API_URL ?? "http://localhost:3000");
  ```
- Now `apiClient.sessions[":id"].$get({ param: { id } })` and
  `apiClient.chat[":sessionId"].$post({ json: {...} })` are **fully typed from the
  server definition**. If you change a route's body schema or response on the
  server, the client call site red-squiggles. No codegen, no OpenAPI — it's pure
  TypeScript inference across the package boundary (this is "tRPC-style" but
  built into Hono).
- `screens/session.tsx` even pulls response types straight from the client with
  `InferResponseType<typeof apiClient.sessions[":id"]["$get"], 200>` to type its
  local state. The DB schema, server, and client share one source of truth.

The `shared` package reinforces this: the model list, the zod schemas for SSE
events (`chatStreamEventSchema`), and the message-part schemas are all defined
once and imported by both sides, so the **wire format is validated on the client
and typed on the server from the same definitions.**

---

## 10. File-by-file reference

### `packages/cli/src`
| File | Responsibility |
|---|---|
| `index.tsx` | Boots the OpenTUI renderer; defines the memory router (`/`, `/sessions/new`, `/sessions/:id`). |
| `layouts/root-layout.tsx` | The nested provider stack wrapping every screen. |
| `layouts/theme-root.tsx` | Root `<box>` painting the themed background. |
| `screens/home.tsx` | Landing screen: logo + input; submit → navigate to new-session. |
| `screens/new-session.tsx` | Creates the session via API, then redirects into it. |
| `screens/session.tsx` | Loads/prefetches a session, maps DB→client messages, hosts `SessionChat`, wires Esc-to-interrupt. |
| `hooks/use-chat.ts` | **The streaming engine.** Manages messages, the live streaming bubble, submit/abort/interrupt, SSE parsing, staleness guarding, auto-resume. |
| `lib/api-client.ts` | The typed Hono RPC client. |
| `lib/http-errors.ts` | Normalizes `{ error }` responses into a message string. |
| `theme.ts` | The 30+ theme palettes + `ThemeColors`/`Theme` types. |
| `providers/theme` | Active theme + disk persistence. |
| `providers/keyboard-layer` | The layer stack + Ctrl-C responder chain. |
| `providers/toast` | Transient notifications. |
| `providers/dialog` | Modal overlay system (keyboard-layer integrated). |
| `providers/prompt-config` | `mode` + `model` state for outgoing messages. |
| `components/input-bar.tsx` | The textarea + status bar + slash-menu; Tab toggles mode; base-layer responder. |
| `components/session-shell.tsx` | Chat layout: sticky-scroll message log + input + status line. |
| `components/status-bar.tsx` | "Build/Plan > model" indicator. |
| `components/header.tsx` | ASCII-art "Chroma code" logo. |
| `components/spinner.tsx` | Themed activity spinner. |
| `components/border.tsx` | Custom border-character sets (the `┃` accent bars). |
| `components/messages/*` | `UserMessage`, `BotMessage` (with streaming/interrupted/metadata states), `ErrorMessage`. |
| `components/command-menu/*` | Slash-command palette: `commands.tsx` (definitions), `filter-commands.ts`, `use-command-menu.ts` (state + keyboard nav + layer push/pop), `index.tsx` (render), `types.ts`. |
| `components/dialog-search-list.tsx` | Reusable searchable/keyboard-navigable list used by dialogs. |
| `components/dialogs/*` | Concrete dialog contents: models, agents (mode), sessions, theme. |

### `packages/server/src`
| File | Responsibility |
|---|---|
| `index.ts` | Hono app, error handler, route mounting, `AppType` export, port/idle config. |
| `routes/sessions.ts` | Session/message CRUD. |
| `routes/chat.ts` | SSE streaming endpoints + the model relay + persistence. |
| `lib/models.ts` | Resolve model id → AI-SDK provider model; exhaustiveness-checked. |

### `packages/shared/src`
| File | Responsibility |
|---|---|
| `models.ts` | The canonical `SUPPORTED_CHAT_MODELS` list, pricing, default, lookup helper. |
| `schemas.ts` | Zod schemas for SSE stream events and message parts. |
| `index.ts` | Public re-exports. |

### `packages/database`
| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | Enums + `Session`/`Message` models. |
| `src/client.ts` | `.env` loading + Prisma/Postgres client singleton. |
| `src/index.ts`, `src/enums.ts` | Re-export generated client + enums. |

---

## 11. Quirks, gotchas, and unfinished edges

Useful to know before you start hacking:

- **Intentional-looking misspellings are load-bearing.** `messsages` (3 s's) in
  the Prisma model and every query/usage; also `DEFULT_DURATION`, `useage`
  (command), `visiblHeight`, `AgentsDialogContext` (should be "Content"). They're
  *consistent*, so they compile. Rename one occurrence and you break the build.
- **Mode/model aren't fully wired into sends yet.** `PromptConfigProvider` tracks
  `mode` and `model`, and the UI lets you change them, but a couple of submit
  paths in `screens/session.tsx` / `new-session.tsx` still hardcode
  `mode: "BUILD"` and `DEFAULT_CHAT_MODEL_ID`. So the Tab toggle and `/models`
  dialog update the on-screen indicator but don't yet change what's actually sent.
  Likely an intentional in-progress seam.
- **`parts`, reasoning, and tool-calls are scaffolded but not produced.** The
  schemas and the DB column exist; the server currently only forwards plain
  `text-delta`s. The richer event types (`reasoning-delta`, `tool-call`,
  `tool-result`) are defined for the future.
- **No auth.** `userId` is `"mock-user"` everywhere. The `/login`, `/logout`,
  `/upgrade`, `/usage` slash commands are placeholders with no `action`.
- **Config path oddity.** The theme config writes to `~/.config/.dooeycode/` —
  another name for the project (`nightcode` / `Chroma code` / `dooeycode`). Cosmetic.
- **You need a Postgres + API keys to run it.** `DATABASE_URL` in a root `.env`,
  plus provider keys for the AI SDK (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). Dev
  scripts: `bun run dev:server` and `bun run dev:cli` (see root `package.json`).

---

### TL;DR for your brain

- It's **React you already know**, with a terminal renderer instead of the DOM.
- The **providers** are vanilla React context; the only new one conceptually is
  the **keyboard-layer stack**, which re-implements "focus + event capture" that
  the browser normally gives you for free.
- **Streaming** is just: keep the HTTP response open, push tiny pieces over time,
  and on the client reassemble *bytes → characters → events → meaning*, each layer
  **buffering** its own kind of incomplete unit. `AbortController` is the cancel
  button. Once that pipeline clicks, the rest is ordinary client/server code.
