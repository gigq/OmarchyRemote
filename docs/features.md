# Feature reference

What each app in Omarchy Remote does and the limits it enforces. "The host" is the machine running the backend; its name appears in every status line from `OMARCHY_HOST_NAME`.

## Terminal

Terminal opens a real interactive login shell on the host through the Rust backend. Tap its output to open the system keyboard. **Keys** mode sends input immediately, with autocorrect disabled for commands and paths. The shortcut row appears only in Keys mode and provides Esc, Tab, arrows and Ctrl; Ctrl applies to the next letter. On a computer (the desktop app, or a browser that is not on iOS or Android and is used with a mouse or trackpad), and on an iPhone, iPad, or Android device with a keyboard connected, Terminal takes typing itself, as a desktop terminal does: there is no message box or shortcut row, and every key, including Home, End, Delete, function keys, Ctrl and Alt combinations, reaches the shell. The shell survives live reload and reconnection; `exit` closes that shell tab; closing the last tab closes the Terminal window. Closing Terminal from Expo terminates its app-owned shell; reopening starts a new one. Files can open a shell in the current folder after confirming replacement of the app-owned Terminal.

⌘Return opens or focuses Terminal; ⌘T adds a tab in the active app (Terminal or Browser), rather than launching Terminal. Terminal input receives focus immediately, and keystrokes typed during its initial connection are held until the shell is ready. With a hardware keyboard, the active window’s input stays enabled across window/workspace changes and closing another window. Native build 36 restores the WebKit text-input session through a native-initiated focus call; callbacks for a window that is no longer active, a dismissed input, or an open overlay are rejected. This applies to Terminal and herdr’s selected pane through the shared input bridge. Output text can be selected: the input never takes focus back during a press or while text is selected. On iOS a long press with the input focused only ends its editing session, so after a long press on the output the input stays unfocused, with the keyboard down, and the next long press selects; this holds on iPhone too, where the input loses focus only after the finger lifts. Tap the output or start typing to return to the input.

## Herdr

Herdr shows the local running Herdr's workspaces, agents, statuses and panes. Workspace and tab ordering follows Herdr Mobile's priority groups: needs attention, working, done, idle, then unknown. Recent Herdr activity sequences break ties before desktop tab order; panes within a tab sort by activity. Tap a pane to view live ANSI output. Right-click a pane (a two-finger click on a trackpad) or long-press it for **Rename**, which names its tab, and **Close**, which asks first and then closes the pane, ending what runs in it. On a computer, or with a keyboard connected, Herdr keeps its message box and Keys mode but leaves out the Esc, Tab, arrow, and Ctrl row, since the keyboard has those keys. Tap the output to open **Message** mode: edit a local draft using the phone's predictions, autocorrect, dictation or swipe typing, then tap **Send** or Return to send it with Enter. Switch to **Keys** for immediate input to interactive programs: each key is typed into the pane, so Vim and other full-screen programs treat letters, Escape and `:` as commands, whereas a message from Message mode arrives as one paste. Herdr does not report a pane's cursor, so a cursor is drawn only at a shell prompt, after what you typed and before any grey autosuggestion; full-screen programs such as Vim and agents show none rather than a misplaced one. Drafts are saved locally per agent thread and survive switching panes, reloads, and app restarts. The back chevron returns to all panes. Existing panes are not focused or resized on the desktop. No input is replayed after a disconnect. Closing Herdr disconnects the phone view and leaves desktop panes and agents running; Herdr sessions are owned by Herdr and survive a backend restart.

A Claude agent that has finished its turn but still has background commands, background agents, or Monitor watchers running shows **waiting** instead of done or idle, sorts with working agents, and lists what it is waiting on under its folder, such as ⏳ Run the full Playwright suite +1 (the full list is in the line's tooltip). The pane header reads "waiting on 2 background tasks", and Home's Herdr widget counts it as working, labelled Waiting. The list updates when the tasks finish.

The slash control focuses pane search. Slash, plus and folder controls use matching square keycaps and consistent icon strokes and colors in the sidebar.

Herdr’s wide-mode sidebar can be resized by dragging its divider, or hidden with the sidebar button. The same button in the pane header restores it. Width and visibility are remembered per device; phone navigation stays unchanged. Focus the divider and use arrow keys to resize, or double-click it to restore the default width.

**+** beside the pane search starts a new Herdr workspace. It opens Files as a folder chooser over the Herdr tile: it lists folders only, keeps breadcrumbs and search, and can create a folder, which it then enters. **start here** creates the workspace with its shell in the current folder, names it after the folder, and opens the new pane; the desktop keeps its focus. Folders must be inside the home directory. If Herdr refuses, the chooser stays open with the error. The chooser remembers its last folder separately and does not change the Files app's mode or recents.

**+** at the right of an open pane's header adds a tab to that pane's Herdr workspace. The same chooser opens in the pane's current folder, so **start here** is one tap, and the new tab's pane opens. On a wide tile, where the pane list is a sidebar and the pane has no header, each workspace's header in the sidebar has the **+** instead.

The folder button opens the selected pane’s current directory (the foreground process directory when available). In the desktop client connected to its own host, it opens the OS default file manager. The client verifies the server’s host ID against the local backend settings database before opening a local directory; matching names or paths alone are insufficient. Mobile, browser clients, remote hosts, missing local identity, and failed system opens use in-app Files instead. It reuses the main Files window and clears its previous search or preview. On wide tiles the button sits beside pane search; on smaller tiles it sits in the pane header. Browse or preview files without sending anything to the agent.

Herdr’s microphone button or **⌘⌃X** toggles recording on the client. Audio goes to the connected host for Voxtype transcription (or a configured command). The transcript appends to the original thread’s saved draft, including edits made during transcription; it never sends automatically. Escape discards a recording; failed uploads/transcriptions offer Retry in an overlay while the view stays open. Recordings stop at two minutes, and moving the app into the background cancels microphone capture. Settings shows host provider status. Native iOS microphone support requires build 40 or later; other wrappers must allow microphone capture. See [dictation configuration](dictation.md).

**Voice mode.** Tap the microphone to talk: it records at once and turns on a quiet Voice mode, with an 80 px floating **Talk** button near the top right of the output. Tap **Send** on it to finish; it shows **Wait…** during transcription, and **Talk** again for the next message. Replies are not read aloud until you hold **Talk** for 550 ms, which switches reading aloud on (a speaker badge shows it) and off again. Hold the bottom-bar microphone instead (or focus it and press Shift+Enter) to start Voice mode with reading aloud on, as for the car. While Voice mode is on, the bottom-bar microphone turns it off; it shows headphones while replies are read aloud. In a thread Voice cannot follow, such as a shell, a tap is ordinary dictation into the draft. **⌘⌃X** also dictates into the draft. A recording sends automatically when the composer was empty, including to a busy agent, as Send would. An existing draft, or a send that could not be confirmed, stays in the composer.

New Codex and Claude prose is read aloud in order, a paragraph at a time as it appears in the agent's transcript: the first reply, progress updates, then the completed answer, never interrupting what is already playing. Tool calls and their output, reasoning, and worker messages stay silent, and text already there when Voice starts is skipped. Stop, a new recording, or switching threads cancels queued speech; after a switch, the new thread stays silent until you send it a voice message. **Read** and **Stop** sit beside **Fit** and also work outside Voice mode; Read plays the latest completed answer.

The host generates the audio with Piper by default, or with the bundled Kokoro adapter (voices, two-voice blends, speed, and playback that starts before the whole answer is generated) or Qwen3-TTS adapter. Codex terminals run by the Codex daemon are matched by their exact saved conversation name and folder. See [Voice conversations](dictation.md#voice-conversations) for setup, privacy, and the foreground-only limitation.

Herdr's paperclip opens the phone file picker (photos or any file from Files, such as a ZIP), and the composer accepts pasted files. Files up to 100 MiB each upload through the backend to `~/.local/share/omarchy-remote/uploads/` on the host, keeping a sanitised copy of their name so the agent can tell `report.zip` from a screenshot. Files have private permissions and are retained until removed on the host; they are not web assets. Each attachment appends `Image: /absolute/host/path` for PNG, JPEG, GIF, WebP or HEIC/HEIF content and `File: /absolute/host/path` for anything else to the original pane's draft, even if you switch panes during upload. Review the draft and press Send to submit; uploading never sends terminal input automatically. A message with an image sends with one press: the host waits for Claude Code to attach the image before pressing Return.

## Output views

Terminal and Herdr output use native browser overflow scrolling, including smooth pixel movement and the system's momentum. Output text can be selected and copied: drag with a mouse or trackpad from anywhere on a line, including its first characters, or long-press on a touch screen. A line ends where its text does, so a selection does not run on into the terminal's blank columns, and several lines copy as separate lines without trailing spaces. The thin strips along the output's edges that keep finger swipes there from reaching the text step aside for a mouse or trackpad. Like a terminal window, the open Herdr pane takes the size of the view showing it: a pane opened on a phone is laid out about 50 columns wide, and the same pane opened on a Mac or iPad, rotated, or in a resized desk tile is resized to fit there, so shells and programs wrap and draw at the width you see. This also gives panes created from the app a real size; with no desktop Herdr client attached, Herdr would otherwise start them at 44 columns. An on-screen keyboard leaves the height alone, so programs do not redraw each time it opens. An attached desktop Herdr client lays out the tabs it shows at its own size again. **Fit** is enabled by default in Herdr and wraps output at word boundaries without changing the pane. Tap it for **Original** when reading tables or terminal layouts that need horizontal scrolling; the choice is saved. While a full-screen program such as Vim or less runs, Fit steps aside and the program keeps its own layout; agents keep wrapping. **↓ Latest** sits beside Message and the keyboard-dismiss arrow while typing, and floats over the output when the keyboard is hidden. It returns to live output; direct typing and sending a message also follow it. Keyboard resizing preserves the prompt at the bottom, or your history position when reading older output. Herdr sends a pane's last 300 lines while you follow it; scrolling back loads up to 1,000 without moving what you are reading, so a long response that ran off the top can be read in full. Surrounding history anchors the view even when Claude or Codex redraws a repeated section; back-to-back updates retain the pending scroll position before the next repaint. Herdr keeps more history than that, but its API reads at most 1,000 lines. Hide the keyboard with **⌄**. Text entry uses the system keyboard or a connected hardware keyboard throughout the app, including the launcher. The prototype touch keyboard and its SUPER layer have been removed. Switching from herdr to a web app cannot reveal a shell keyboard.

If the backend or Herdr is unavailable, the app shows a connection error and retries. The native app's bundled offline copy cannot reach the host APIs.

## Links

Web addresses open inside Omarchy Remote, straight to the page: links in Chat, Muster, and Canvas replies, links on a canvas's page that lead to another site, and addresses in Herdr and Terminal output, which are underlined. An address that an agent's text wrapping broke across lines is found whole, as is one the terminal wrapped; trailing punctuation is left out. Tap or click one to open it; in a program that tracks the mouse, such as Vim with mouse support, Command- or Ctrl-click it, since a plain click goes to the program. The page opens in a browser window with back, forward, reload, the page's address, a key to open it in the system browser, and a close key; another link reuses the window. The window is the same native web view saved web apps use, so it needs the iPhone, iPad, Android, or desktop app; in a plain browser tab, links open in a new tab. It is not on Home or in the launcher; it opens when a link does.

## Corral

Corral is a Slack-style workspace for you and your agents, separate from Herdr. The sidebar lists channels and a direct message with each agent (with what each is doing); the conversation shows messages by author, in Markdown, with @mentions and links. On a phone one shows at a time; with room, both side by side. Right-click or long-press a channel or agent to edit or delete it. Agents whose home folders share a parent (two agents in `~/git/moving-records`, say) are listed together under that folder's name, which collapses and expands with a tap and remembers which way it was; a collapsed folder shows how many agents it holds and whether any is working. Grouping only arranges the sidebar: agents still talk anywhere they are mentioned.

**+** beside Direct messages makes an agent: a name, which is its @handle, in whatever case you like (such as AsBuilt), though @mentions and uniqueness ignore case and @you, @here, @channel, and @everyone are taken; Claude X (Claude Code through your `claudex` proxy, which adds its Gemini models to the model list; the default where it is installed), Claude, or Codex, of those installed on the agent's machine; a model and effort, which can change later; a home folder, where its sessions start (**Choose…** picks one with Files); and standing instructions, given to it in every conversation. An agent's picture is `avatar.png` (or `.jpg`, `.webp`, `.gif`, or `.svg`) in its folder, `~/Corral/agents/<id>/`; agents are told so, and to draw it bold and simple so it reads at about 30 pixels, so you can ask one to make its own, and the sidebar and its messages show it from the turn it appears. Without one, its initial shows. **+** beside Channels makes a channel with a topic and members; its name keeps the case you give it (such as MovingRecords), and uniqueness ignores case.

Typing @ offers the names to mention: tap one, or press Tab (Shift-Tab back) to put each in place in turn, Return to keep the one there, or Escape to close them. A direct message wakes its agent; in a channel, an @mention wakes that agent (and brings it into the channel if it was not a member), and @here wakes every agent there. A woken agent catches up on what was said since it last spoke in that conversation, and its final reply is posted as its message; it is told it is in a chat app, so it answers like a colleague texting in Slack: one to three short sentences that lead with the answer, with no lists, reasoning, or rundown of everything pending unless you ask. Each message it is given ends with that reminder. An agent's reply that mentions another agent wakes that one too, up to six replies in a row without you, after which Corral stops and says so. While an agent works, a line under the conversation says what it is doing, with **Stop**.

**Agents that set up agents.** Each turn has a `corral` command on its path, so an agent can work Corral itself: list agents and engines, make an agent (name, engine, model, effort, home folder, instructions), make channels, invite agents, and post and read in channels. `corral help` lists what it does, from Corral itself, so it stays current. Ask one agent to stand up the agents for a project and it can; Corral notes what it did in the conversation ("@maker made @helper (Claude · haiku, in ~/git/project)"). The command acts only as that agent and only while its turn runs, through a token for that turn; an agent can make up to 40 agents in all.

**Activity.** The panel key in a conversation's bar, beside ⋯ (or beside Corral's heading while no conversation shows), opens the details panel on the right, as in an editor, which for now holds Activity: every place a conversation is going, each channel, direct message, and thread, newest first, with its latest message and who sent it, the message a thread hangs from, and how many replies it has. Replies that came in since you last looked at that place, on this device, stand out, and a dot marks where an agent is working. Tap one to open it, thread and all, as if from the sidebar or its message. With room (a window 1000 pixels wide or more) the panel sits beside the conversation and stays open as you move around; otherwise it takes the conversation's place until you choose one. It stays open or closed as you left it.

**Threads.** Right-click or long-press a message (or use **Reply** on hover) for **Reply in thread**; the thread opens in place of the conversation, with a back key, and its replies stay out of the timeline, which shows "3 replies" under the message instead. In a thread, mentioning an agent wakes it as usual, and a reply that mentions no one wakes the agents already in it: whoever wrote the message it hangs from and every agent that has replied. An agent's first turn in a thread starts from the conversation as it stood at that message: a Claude or Claude X agent's session there is forked at that point, so it knows what was said up to the message and nothing said after, and a Codex agent starts with the messages leading up to it. Later turns in the thread continue its own session, and the agent's work in the conversation itself is untouched.

**Agents on other machines.** Other machines can run Corral too (the standalone `corral` program, on macOS, Windows, or Linux), with agents of their own that work there: its folders, tools, and files. List a machine in `~/Corral/hosts.json` and its agents join yours, grouped under the machine's name (with "not reachable" when it does not answer). Message or mention one as any other; its turn runs on its machine, which is sent what is new in the conversation and streams back what the agent is doing and its reply, and **Stop** ends it there. Agents are told which machine each is on, so one on this host can mention the agent on a Windows machine to have something done there. **+** beside Direct messages offers a **Machine** to make an agent on, with that machine's engines; its home folder is typed, since Files browses this host. An agent can make one there too, with `corral create-agent --host NAME`. Names are taken to be unique across machines; one whose name is taken shows as `@name-machine`. [backend/corral/README.md](../backend/corral/README.md) covers setting up a machine.

**Voice.** The microphone beside the message box works as in [Chat](#chat): tap it to talk, and the floating **Talk** button sends each recording as a message to the conversation or thread on screen, so you can keep talking with hands on the wheel; hold **Talk** (or the bar microphone) to have the agents' replies read aloud as they arrive, in a channel each with who said it ("As Built says: …"). **Read** replays the latest reply and **Stop** cuts it off. Dictation hears names as words, so a second pass turns them into the real mentions they sound like, allowing for a slight mishearing: "at as built" becomes @AsBuilt, "at coral" @Corral, "hash moving records" (or hashtag, or pound) #MovingRecords, "at here" @here, and a message that opens by addressing an agent ("As built, where were we?") mentions it. An ordinary "at" ("meet at noon") stays, and a name of four letters or fewer has to be heard exactly.

Each agent has its own session in each conversation, so it can work in one channel while waiting on a long command in another. Each turn also tells it the latest message in its other conversations and gives it its memory file (`~/Corral/agents/<id>/memory.md`), which it keeps itself, so it stays aware of what it is doing elsewhere; it can read any conversation's file to look further back. Agents run with every tool allowed. Claude Code's automatic memory is off for them, so Corral conversations are not written into a project's Claude memory; an agent's memory file is its one memory, whatever its engine. Everything is plain files in `~/Corral` (`OMARCHY_CORRAL_DIR` moves it); agents call you by `OMARCHY_CORRAL_PERSON`, or your account's name.

## Muster

A muster is when a herder gathers the whole herd in one place to count and inspect it. Muster shows every Herdr agent thread on one board, grouped by project (Herdr workspace), so you can see what needs you without reading each pane, and drive the threads from there. Threads stay in Herdr, and **Open in Herdr** jumps to one when you need the full terminal. The folder button beside it opens the thread's working folder, as Herdr's does: in Files, or in the desktop's own file manager when Muster runs in the desktop app on the host.

Each project is a card, with a row for each of its tabs that runs Claude or Codex. Projects are grouped by what needs you, each section headed with its count: **Needs you** (an agent waits on a question or an approval), **To review** (a finished reply you have not looked at), **Working** (the agent is handling your request), **Waiting** (its reply is done, but a build, background agent, or other task it started still runs), then **Quiet** (reviewed or idle), most recent first within each. Opening a thread in Muster reviews its latest reply, as looking at it in Herdr does, and **Mark all reviewed** clears the column at once; reviews are kept on the host. A project with several tabs goes where its most pressing tab puts it: a question first, then work in progress (working, then waiting), then a reply to review, and a line under its name counts the rest (_1 working · 1 to review_), so a finished tab is not hidden. A turn that failed, such as on a usage limit or an error the agent's API returned, also needs you: its row is badged **Usage limit** or **Error** and shows the agent's message (for example when its limit resets), and the thread shows it after whatever was written, with **Dismiss** to take it out of Needs you when you will fix it in Herdr or a terminal; a new failure brings it back. Rows are badged **Question** or **Approval**, and **Unknown status** or **Unreadable** when Muster cannot tell. The sections stack on a phone; once Muster's window or tile is about 900 pixels wide, they stand side by side as columns, each fitting as many cards across as its width allows. A row shows the thread's title (Claude's own title for the session, or a Codex goal), the question it is asking, or its latest prose, and the header counts what needs you. The Home tile's badge counts open questions.

Right-click a row or long-press it to **Rename** the thread's Herdr tab or **Close** its pane, as in Herdr. Tap a row to open the thread: your last message, what the agent has written since (as it writes, while working), its background tasks, and a message box. Between the agent's paragraphs, a gray line sums up the work in place of its tool calls and output, such as _Worked 1m 20s · 8 tool calls · 3 files changed_ or _Thought for 12s_, and while it works the last line counts up every second (_Working 45s · 2 tool calls_), from the moment you send a message, so you can tell where you were reading and what happened between replies. Chips switch between the project's tabs. A message you send shows at once, with the working timer already counting, and the reply to your previous message folds into a dimmed **Previous reply** above it; until then the board row shows your message rather than the old reply. When you come back to a thread, **Earlier in this thread** above your last message counts what came before it; open it for a short summary of the goal, what was done and decided, and what is still open. The summary is made only when you open it (Claude Haiku on the host, in about three seconds), from your messages and the agent's prose without tool output, and kept until the thread has a new turn. A question appears as a card with its choices; tap one to answer, as the agent's own menu would. For several questions, each is answered in turn and then submitted from the review step. Multi-select choices toggle in Muster and go together with **Continue**. Where the question offers **Type something**, the message box types your own answer. Permission prompts show what they would run. Muster reads questions from the agent's screen, since agents record them only once they are answered, and it sends nothing if the question changed before you answered. A wait it cannot read as choices, such as Claude's folder-trust prompt, shows the screen with keys (↑, ↓, 1–3, Tab, Enter, Esc) to answer it. While an agent waits, the message box only answers its question; otherwise a message is sent as Herdr's Send would.

Hide a project you are not working on with the eye button on its card. Hiding changes nothing in Herdr; **Show hidden projects** lists them, with **Show** to bring one back. Hidden projects are saved on the host, so every device shows the same board, and a hidden project that asks a question is still announced at the top. Codex conversations are matched to their logs whether the pane runs `codex` directly or resumes through the Codex daemon (by the conversation's name, or for a folder's only unnamed conversation, by its folder); one that still cannot be matched, such as one of several unnamed conversations in the same folder, shows its state and can be opened in Herdr, but not read in Muster.

## Canvas

Canvas is a conversation where Claude answers by building the page you see. Ask for anything, by typing or with the microphone, and Claude writes a page for it: a chart, a comparison, a timeline, a map, a calculator, a guide, a game, whatever fits. The page fills the screen and reloads as Claude changes it, and Claude's reply, a sentence or two, is a subtitle beneath it: tap it to see your question and the whole reply, or select its text to copy it. While Claude works, the subtitle says what it is doing: thinking, searching or reading the web, or drawing. Voice mode works as in Chat; with replies read aloud (hold the microphone), the subtitle shows what is being said, a few lines that follow along, with each word lit as it is spoken. Pages can answer for you: a button or a form on the page sends its message to Claude as your next one, so a page can be an interface you drive. Where Claude X (your `claudex` proxy) is installed, Canvas runs Claude through it, for every canvas and for Redraw and icons, so pages keep coming when your Claude account's own usage runs out.

The full-screen key at the end of the subtitle's row shows the page over the whole window, hiding the header, subtitle, and message box (and over the whole screen where the browser allows it, as on a Mac); the corner key or Escape brings them back. The arrows beside the subtitle go back and forward through the pages earlier turns left, each with the question and reply that made it (⌘⌃[ and ⌘⌃] on a keyboard). Send from an earlier page, by typing, talking, or from the page itself, and the conversation continues from there: the page is put back as it was, Claude carries on as if the later turns never happened, and those turns are dropped. Claude's own memory files, if it writes any, are not rolled back. Canvases made before history was added start keeping pages from their next turn.

Each canvas is a folder in `~/Canvas` (set `OMARCHY_CANVAS_DIR` to move it), holding its transcript and the page Claude writes there (`index.html`, with any files it adds), and the list, settings chip (Claude or Claude X, model, and effort), attachments, folder button, archive, and delete work as in Chat. Claude runs there with every tool allowed and a brief that tells it how its page is shown; with each message it is given the screen's size, the kind of device, and the current theme's colors, to design for or depart from. The settings chip also sets the canvas's **Design** level, shown first on the chip: **quick** (good design that mostly follows the built-in theme, well laid out, with no custom elements or complicated UI), **medium** (the default: a well-organized, good-looking page with some custom elements and images where they make sense), **detailed** (well beyond the basics in content and presentation), or **max** (maximum information, maximum style in the UI). Each level adds one line to what Claude is given with every message, and only sets how much time goes into the page's design; how much Claude researches follows what you ask. A change applies from the next message, and new canvases start with the level used last. A page is made for the screen of the message that last changed it: a phone, or a wider screen (iPad, Mac, or desktop). Opened on the other kind, it offers **Redraw for phone** (or **Redraw for this screen**) at the bottom of the page. Claude then writes a version for this screen beside the original, in a separate run that knows the conversation but adds nothing to it, and each kind of screen shows its own version from then on. When a later turn changes the page, the other version is out of date and the button returns. Canvases made before this take the screen of their last message. Each canvas has an icon in the list, beside its title: after a canvas's first turn, a separate run of Claude that knows the conversation draws `icon.svg` in its folder, a polished app icon it renders and refines until it reads well at small sizes, and the list shows Canvas's paintbrush until it has one (so does an empty list, where Chat shows chat bubbles). Pages load anything from the web, such as charting or 3D libraries and fonts, and run in a sandboxed frame apart from the shell: they cannot reach the app, its storage, or the host.

## Chat

Chat is a ChatGPT-style conversation with a coding agent that needs no project: Claude Code, Codex, or Claude X (Claude Code through a local CLIProxyAPI, from the `claudex` command), each offered when its command is installed on the host. Choose the agent in the chat's settings chip, beside the model and effort; new chats start with the one used last. A chat can move between Claude and Claude X, which share their conversations, but a Codex chat stays Codex, and Codex runs its own configured model with its own effort levels (low to xhigh). Tap **New chat**, type, and the reply streams in as Markdown: headings, lists, tables, code blocks, and links, which open in Omarchy Remote's browser window (see [Links](#links)). Lines such as **WebSearch** note the tools Claude used; its reasoning and tool output stay hidden. **Stop** ends a reply and keeps what was written so far. Tap the message box to type; sending a message or tapping the conversation hides the keyboard. As in Herdr, raising the keyboard pushes the conversation up, so the latest message stays just above the message box, or the text you were reading stays in place. The chat list shows each conversation's title (its first line), last message, and age, and the app reopens the last chat after a reload. The chip in a chat's header shows its model and effort; tap it to choose a model (Fable, Opus, Sonnet, Haiku, or Default) and an effort level (low, medium, high, xhigh, max, or Default). Default follows your Claude settings unless the backend environment sets `OMARCHY_CHAT_DEFAULT_MODEL` or `OMARCHY_CHAT_DEFAULT_EFFORT`, such as `OMARCHY_CHAT_DEFAULT_MODEL=opus`. The choice is saved with the chat, applies from the next message, and new chats start with the last one you picked. Tap **Select** to pick several chats, then **Archive** them or **Delete** them. Right-click a chat (a two-finger click on a trackpad), long-press it on touch, or press the menu key for **Rename**, **Archive**, and **Delete** on that one; Delete asks in the menu first. Renaming changes the title the list and header show; the folder keeps its name. Canvas's list works the same way. Archived chats move to `~/Chats/archives` with their folders, still readable and kept in git, along with Claude's record of the session. **Archived · N** under the list opens the archive: each chat there has **Restore**, which moves it and its sessions back to the list so it can be continued, and its right-click or long-press menu also offers **Delete**. Canvas's archive works the same way, with each canvas's icon. Delete asks first, then removes the chat's folder, including files made in it, and Claude's copy of the conversation (its session log and the session's other files in `~/.claude`); it cannot be undone. A message that cannot be sent stays in the composer as a draft.

The paperclip beside the message box attaches files, as in Herdr: on iOS it offers the photo library and Files, and pasting an image or file attaches it too. Each upload (up to 100 MB, 20 per message) waits above the message box, with a thumbnail for pictures and **✕** to remove it, and stays there with the draft until you send. A message can be only files. Sending moves them into the chat's `attachments` folder; Claude sees PNG, JPEG, GIF, and WebP pictures up to 3.75 MB directly and is told the path of every file, so it can read the others. The conversation shows pictures in the message and other files by name; tapping one opens the `attachments` folder in Files, and `chat.md` links them.

The microphone beside the message box works as in Herdr's [Voice mode](#herdr): tap it to talk, and the floating **Talk** button sends each recording as a message, with any files waiting to go; hold **Talk** to have replies read aloud, or hold the bar microphone to start Voice mode reading aloud. Claude's reply is read a paragraph at a time as it arrives. Voice mode follows you from chat to chat, including a new chat started by voice, and **Read** and **Stop** appear in the conversation's corner while it is on. **⌘⌃X** dictates into the draft.

Each conversation is a folder in `~/Chats` (set `OMARCHY_CHAT_DIR` in the backend environment to move it), named with its date and title, such as `2026-10-03-dinner-ideas-1b8ab544`. Its `chat.md` is the readable record of the conversation, and Claude runs in that folder, so files it creates stay with the chat. The folder button in a chat's header opens it in Files. A chat that grows into real work can be moved to a project location later or opened in Herdr for another agent; Claude finds its session by id, and `claude --resume` continues it. Claude reads `CLAUDE.md` files from parent folders, so a `~/Chats/CLAUDE.md` gives every chat the same instructions. `~/Chats` is private to your user, and you can keep it in git to back it up. Chats saved before folders are converted when Chat next lists them. A conversation's Claude process stays running between messages and stops after 15 idle minutes; the next message resumes it. Web search and fetching web pages are allowed; other tools that would ask for approval, such as running commands or editing files, are denied for now. To allow everything, as `--dangerously-skip-permissions` does, add `OMARCHY_CHAT_CLAUDE_ARGS='["--permission-mode","bypassPermissions"]'` to the backend environment (`~/.config/omarchy-remote/backend.env`) and restart the backend. The same setting takes other Claude Code arguments, such as a `--model`.

## Files

Files browses the host home directory with breadcrumbs, grouped folder and file rows, extension badges, and real metadata. Search names in the current folder, contents below it, or names and contents across HOME. The menu also offers a fuzzy finder with recent files and home, git, and config shortcuts. Search supports case, hidden files, regex and glob filters. Searches are bounded and report when results are limited; `.git`, `node_modules`, `target`, and `.cache` trees are skipped.

Tap a file for an image or syntax-colored, line-numbered text preview, shown at the same text size as the editor. The file menu toggles wrapping. Edit saves UTF-8 text on the host and detects external changes before replacing a file, retaining the draft on conflict. Text preview and edit are limited to 1 MiB; transfers and images to 25 MiB each. On iPhone, Save… opens the iOS share sheet.

Select or long-press a folder row to enter selection mode. Select all, invert, or use a wildcard pattern; then download a ZIP, move, copy, rename one item, or send items to the recoverable host Trash. Selection supports up to 100 items. Copy and archive are limited to 25 MiB and 10,000 entries per tree; symlinks and special files are rejected for these operations. Existing destinations are never replaced. New creates folders or empty files; Upload uses the phone picker and keeps its original target folder after navigation.

The last folder and recent paths are remembered. Access stays inside HOME; external symlinks and the backend's private environment file are excluded, and operations cannot move the home directory or ancestors of that file.

## Browser

> **The Browser app is disabled for now.** It needs a lot of work before it is ready, so it no longer appears on Home, in the launcher, in Expo or in shortcuts. Pinned web apps are separate and still work. The code is still here: to try it, run `localStorage.setItem('omarchy-experimental-browser', '1')` in the shell and reload.

Browser resumes the last viewed web tab if it is still open on the desktop; otherwise it shows the tab manager. ⌘⇧L opens the manager. ⌘W closes the shell window; ⌘⇧W closes the current desktop tab. ⌘/ lists browser shortcuts. Shell workspace and window bindings stay active in Browser: ⌘numbers choose workspaces and ⌘brackets move between them. Ctrl+numbers choose browser tabs, Ctrl+brackets navigate page history, ⌘T creates a browser tab (⌘⇧T reopens one), Ctrl+F finds text, and Ctrl+plus/minus/0 controls zoom. ⌘T creates a tab in the active app, ⌘F toggles fullscreen, and ⌘⇧F opens Files.

Browser mirrors Vivaldi (or another Chromium) windows, workspaces and tabs through the companion extension. It supports desktop tab close and create, window moves, pin and mute, reload and focus. Opening a tab loads its URL inside the themed Browser frame in a separate native WKWebView. The website fills the inside of its workspace border. Scrolling down hides the address and navigation bar; scrolling up or tapping the top of the page reveals it. New page navigation restores the controls. The address field and back, forward, and reload controls navigate that local page; website URL changes also update the originating desktop tab. Website logins persist on each device, separately from the desktop browser and from the shell. The page has no host message bridges. The **…** menu holds Reload and **Dark**. Dark forces a dark palette using bundled Dark Reader; the toggle persists on the device and applies to subsequent page loads. Switch it off to restore the original styling without reloading. Cross-origin stylesheets and embedded frames may remain unmodified. The leftmost **‹** returns to the desktop list, and **return to page** resumes the same local page. The list’s × button closes the actual desktop tab. Expo shows a page preview while the native page is hidden. In the PWA, pages still open externally. Links requiring another app are currently unsupported. Tossing Browser from Expo does not close desktop tabs. Vivaldi workspace groups come from saved metadata and may lag briefly; workspace reassignment is unavailable when the extension API hides those fields. See [browser setup](../browser-extension/README.md).

## Host TUIs

btop, Services, lazydocker, dua, and lnav are standalone apps with their own Home tiles, workspaces and Expo cards. The backend starts each program in its own PTY, resumes it across web reloads, and ends it only when its Expo card is tossed. Each has theme colors, a **Fit** view sized to the program's column layout, **Larger** for readable terminal sizing with horizontal scrolling, a row of touch buttons for the program's main keys, and native keyboard input by tapping the output. The table lives in `backend/src/apps.rs`; the touch buttons in `public/remote.js`.

- **btop** runs with its own config at `~/.local/share/omarchy-remote/btop.conf`. Buttons toggle the CPU, memory, network and process panels. Its colors are mapped to the selected phone theme: a transparent monitor background, accent box borders, semantic graph colors and readable text in light and dark themes.
- **Services** runs systemctl-tui with a 64-column Fit view. ↑/↓ navigate, **Select** opens a unit or chooses an action, **Back** dismisses, **Search** filters with the phone keyboard, **Filter** opens status filters, **Help** shows the TUI shortcuts. Both system and user units are shown with the host user's existing permissions.
- **Lazydocker** opens the host Docker context. Panel switches sections, Open focuses details, Tab switches detail tabs, Menu exposes available actions, and Search filters.
- **Dua** scans HOME using two threads and stays on the current filesystem. Open and Up folder navigate directories; Panel switches panes, and Help lists cleanup keys.
- **Lnav** follows the last 1,000 accessible journal entries and new host logs, with a Wrap control for long lines. Search, page navigation, Latest, and Help are available. Other log files can be opened through lnav's `:open` command using the keyboard.

## Home and widgets

Startup opens Home only. In Expo, swipe an app card upward to dismiss it, or hold for about half a second and drag it to another slot to reorder workspaces. Home stays first and cannot be dismissed. Short swipes snap back; a cancelled reorder restores its original order. Workspace order lasts for the current page session.

Home widgets use `/api/widgets` on the backend. One sampler reads Linux CPU and memory counters, the default-route interface's traffic rates, root-filesystem usage, uptime and CPU temperature (when available) every three seconds. Tailscale status and peers refresh every fifteen seconds and describe the host's VPN state, not the phone's. The sampler uses the `df` and `tailscale` CLIs.

Weather uses Open-Meteo's geocoding and forecast APIs via the backend's `curl` client, with fixed upstream URLs, timeouts and a bounded fifteen-minute forecast cache. Choose a city in the weather card, or use the target icon to take the phone's location (the native app asks for when-in-use permission and sends only city-level coordinates). Location and Celsius/Fahrenheit preference are saved per device; automatic units follow the phone locale. Forecast hours use the selected city's timezone. Polling pauses when the page is hidden or Home isn't active, and connection failures show unavailable or stale states.

CodexBar is sampled every five minutes using the installed CLI, with Codex's automatic source and Claude's read-only OAuth source. The CLI is `/usr/bin/codexbar` unless `CODEXBAR_BIN` names a compatible wrapper. The dedicated CodexBar app opens from the launcher or by tapping its Home widget. It shows the plan and the main usage windows first; extra windows the CLI reports (model-scoped limits, or per-account rows from a wrapper) follow in a compact More limits list, collapsed when there are more than three. The Home widget shows the main windows and counts the rest. The app also shows banked resets (count, status, grant and expiry dates), credits and credit events, provider costs, service status, usage pace and other reported usage details. Local Codex/Claude token-cost history includes daily and model breakdowns, cache tokens and coverage when available. Expandable detail sections expose the supported telemetry fields without account identifiers, credentials, diagnostic dumps, or redemption IDs. Unreported values stay unavailable rather than becoming zero. Reset redemption is not supported.

CodexBar also includes a Reset watch card, below the Codex usage windows, sourced from [willreset.com](https://willreset.com/developers): 24/48-hour forecast percentages, confidence, elapsed time since the last reported reset, active reset promises, a reset/banked-reset post feed, and reset history. These are public third-party reports, separate from account usage and banked credit balances. Previews keep their labels and forecasts are not scheduled resets. The Rust backend caches the forecast, feed and timeline independently every five minutes; failures retain the last good section and display a warning. Data older than fifteen minutes is also marked outdated. Expanded lists show up to forty entries with links to the original posts and the full source lists.

Usage and local costs are cached separately on the host every five minutes. The app reads that cache every thirty seconds while visible; Refresh rereads the cache without launching extra CLI processes. Connection failures preserve the last sample in an open app. The app and widget share their provider selection. Widgets registered by an app belong to its provider module: tapping opens the owning app, while embedded controls, scrolling and long-press management retain their behavior.

The herdr app-owned Home widget replaces the separate attention panel. It shows named threads and their projects, prioritizing threads waiting for attention and otherwise showing working threads. Each row opens its specific pane in Herd; tapping the widget background opens the app. Quiet, empty and disconnected states are explicit. It uses the same add/remove/reorder controls as CodexBar. New widget types appear once on existing installations without restoring widgets that were deliberately removed.

Long-press a Home widget (or tap its manage icon) to open the widget overview. Drag after a short hold to reorder, swipe up or tap × to remove, and use the library to add widgets back. Enabled widgets, order and the selected page persist per phone. Removing a widget changes Home's layout without changing the host service or any provider subscription.

## Themes

Settings → This device offers **Focus follows pointer** (off by default). In desk mode, moving a mouse or trackpad pointer over a window focuses it for keyboard input. Touch, dragging, Expo, and open dialogs do not change hover focus. The preference is saved and backed up per device. Embedded Browser and web-app hover is supported on Android and requires native build 29 or later on iPad/iPhone. Native website hover is disabled on visionOS so looking at a window cannot steal focus.

Settings → This device also offers **Edge swipes go back and forward** (off by default). With it on, swiping in from the left edge goes back and from the right edge goes forward, instead of switching workspaces: back leaves a Herdr thread for the pane list, goes up a folder or closes a preview in Files, and goes back in Browser and web-app page history, then returns Home; forward retraces those steps until you go somewhere new. Switch workspaces with the workspace pills or Expo. On Android the system Back gesture and Back button keep working as before; the right edge goes forward.

Theme selection lives in Settings and persists on the device (`omarchy-theme`). The shared CSS tokens also drive the launcher, custom keyboard, Terminal and Herdr; ANSI indexed colors update immediately, while explicit RGB output retains the host application's colors. Web controls follow the palette's light or dark color scheme; the native wrapper still requests a dark iOS keyboard. The portable catalog includes the stock Omarchy palettes plus the original prototype. Refresh it with `python scripts/import-themes.py` (which `deploy/install.sh` runs); stock palettes come from `/usr/share/omarchy/themes`, with `~/.config/omarchy/themes` overlays applied, and the theme backgrounds are converted into the untracked `public/backgrounds/` directory with a `catalog.js` index. This copies color definitions and images only and does not change the host's desktop theme.

## PWA

The standalone build's service worker caches only known app files, rejects redirected install responses, and activates a new version after old app windows close. Close all app windows and reopen to pick up an update. A PWA cannot defer iOS system gestures; the native app can.

Development views reload after source changes, including atomic file replacements. The host checks sources every 750 ms and publishes a reload only after native assets regenerate successfully; a failed regeneration is retried once, then waits for the next source change.

### Adjustable desk tiling

Settings → This device offers Dwindle (Omarchy's default), Master and stack, and Scrolling columns.
Dwindle recursively splits the available area; Master keeps the first window on
the left with the others stacked on the right. Resize with a divider (touch or
pointer), or hold Command and right-drag inside a window. Command + left-drag
onto another tile swaps them. Linux/Windows web clients use Ctrl+Alt. Touch-only
phone workspaces keep their existing geometry.

Split sizes, direction overrides, and layout choice are part of the existing
per-device layout backup. Settings has a Toggle active split direction action.
A keyboard-focused divider accepts arrows in 25-point steps; double-click resets
its size. Fullscreen and Expo hide dividers. Browser and saved website content
forward modifier drags through a native gesture bridge starting with build 30;
ordinary website touches and scrolling retain their normal behavior.

Desk navigation remembers the previous workspace by a surviving window identity,
so closing and renumbering workspaces does not turn it into a stale numeric target.
Command+Shift+P returns there. Command+Shift+X moves to the next workspace without
following; if the source becomes empty, focus returns Home. Moves into an already
full four-tile workspace are ignored. Command+Shift+Y changes Dwindle split direction
and Command+Shift+U cycles layouts. Native hardware registration is included in build 31 and later.

### Action palette and shared keyboard registry

Command+Shift+K opens Search actions. Results include concrete workspace numbers,
window actions, app launchers, active Browser actions, and moving to a chosen
workspace without following. Type to filter, use arrows and Return, or click an
action. Escape dismisses the palette. Native websites are covered while it is open.

The shell binding definitions and provider action descriptors are combined into
one registry, with shell bindings reserved before app shortcuts. Browser uses its
action descriptors for handling and help. Native build 31 receives the registry
from the trusted shell, rather than maintaining a separate hard-coded list in
Swift. Text-editing arrows remain with text fields. Existing Command+/ help is
retained; new actions can be added without another Swift key-list edit.

### Scratchpad

Send any non-Home desk window to the scratchpad with Command+Shift+S, then use
Command+S to show or hide it on any workspace. Hiding preserves the app and its
running session. Command+Shift+S while it is shown returns it to tiling. There is
one scratchpad slot; an occupied slot is never silently replaced. Its window and
floating geometry persist per device, and it starts hidden after a reload.
Command-drag moves it and Command+right-drag resizes it within the desktop bounds.
These actions also appear in the palette and require native build 31 for hardware
key registration. Phone layouts are unchanged.

### Window instances and groups

The action palette offers independent Terminal and Files windows. Each Terminal
window owns its own tab list and PTYs, while each Files window keeps its own folder
and navigation state. App providers opt into multiple instances; the installed app
catalog remains distinct from its open window IDs. Other apps can share a group
without needing multiple-instance support.

Use Group window with next tile to combine the active tile with another in the
workspace. The group shows app tabs above its content. Clicking a tab or using the
existing next/previous-window commands selects it. Remove window from group splits
out the current tab. Closing a grouped window closes only that window. Workspace
layout backups include instance identities, group memberships, and the selected
tab. Terminal session IDs stay local to the client; restoring on another device
starts its own shells. Browser/web-app native surfaces follow visible group tabs.

### Scrolling layout

Settings → Window layout → Scrolling columns keeps windows in a horizontal strip
instead of shrinking all tiles to fit. Columns default to 49% width, matching the
host Omarchy scrolling configuration. Drag a divider or Command+right-drag to set
an individual column between 25% and 100% of the workspace width. Widths persist
per device. Groups occupy one column and keep its width when their tab changes.

Focus-left/right and next/previous window reveal the focused column. The bottom
strip uses native horizontal overflow scrolling for touch/trackpad panning, accepts
wheel input, and has named buttons to focus columns. This does not intercept
scrolling inside app content. Expo scales the complete row into its workspace
preview. Scratchpad remains floating above the workspace; phone geometry is unchanged.

### Floating windows

Command+Shift+O (also in Search actions) toggles a regular desk window between tiled
and floating. Floating removes that window from its tile group and lets the remaining
tiles fill the space. Floating windows retain workspace membership, saved position
and size, and come forward when focused. Command-drag moves; Command+right-drag
resizes. Bounds remain inside the desk when its dimensions change. Fullscreen and
Expo continue to work. An overlapping foreground window covers native web surfaces
behind it with their preview so native content cannot paint over the front window.
The scratchpad remains a separate slot that can follow you between workspaces.

### Independent Browser windows

The Browser app is disabled for now (see [Browser](#browser)).

Search actions → New browser window creates another Browser pane with its own tab
manager, address, back/forward history, find, zoom, and native web surface. Its last
selected desktop tab is saved separately on this device. Closing a window releases
only that window's page, leaving other Browser windows and desktop tabs open. All
windows share the native website data store, including logins. Choosing the same
desktop tab in two panes still targets the same desktop tab when syncing URLs.
Additional embedded Browser surfaces require native build 33; the PWA continues to
open websites externally. Layout backups preserve the additional window identities.

### Direct keyboard resizing

Command+Option+Shift+arrow resizes the active window without first focusing a divider.
Left/right shrink/grow width; up/down shrink/grow height, by 25 points per press.
For tiles, the nearest containing split on that axis adjusts while respecting
minimum pane sizes; grouped tabs resize their shared tile. Scrolling columns resize
horizontally. Floating windows and scratchpad resize within the desk bounds.
Fullscreen ignores resizing. Browser tab navigation keeps Command+Option+left/right.
Search actions also exposes all four resize operations for clients without this chord.

### Custom shortcuts

Settings → Keyboard shortcuts opens the searchable per-device editor. Choose a
shortcut, then press Command/Control plus a key to record a replacement. Escape
cancels recording. Disable removes only its key binding; the action remains in
Search actions. Reset restores one default; Restore defaults clears all overrides.

The shell, Browser, shortcut help, palette and native registrations resolve the
same registry. Remapping removes the old chord, including Return's numeric-keypad
alias. The editor checks Browser's definitions even when Browser is closed,
rejects duplicate bindings (including the Ctrl+Alt web aliases), and protects common
system and text-editing chords. Native iPadOS can still reserve additional keys;
use a different chord if the system consumes one. Overrides are included in the
existing per-device layout backup. Browser custom bindings apply to all Browser
windows. Native build 33 also supports punctuation and combined Command+Control
bindings. Phone workspaces retain their existing geometry.

### Saved hosts and disconnect

Native build 34 introduces a device-local host directory, seeded from the existing
configured URL. Settings and the pull-down launcher expose Manage hosts and
Disconnect. The standalone local picker adds, renames (save the same address),
removes and connects up to ten hosts. HTTPS addresses are canonicalized to the
host’s `/native/` shell; credentials, query strings and custom paths are rejected.
Loopback HTTP is supported for development only. Native Add Host uses UIKit text
fields in a system dialog; the PWA keeps an inline form.

Command+Control+1–9/0 switches hosts by saved order without consuming workspace
number shortcuts. These actions participate in the desk registry, help and custom
bindings. The local picker also accepts their default chords. A disconnect unloads
the shell and embedded web surfaces, cancels automatic reconnect, and stays at the
picker on relaunch; it does not close remote PTYs or agents. Failed live connections
use the selected host’s offline snapshot with the existing retry behavior.

Native preferences are mirrored under the selected host URL. Switch requests flush
the current snapshot before selecting the destination; storage messages include a
host scope so late messages cannot overwrite another host’s state. The bundled
origin replaces its local snapshot on scope changes even when the destination has
no saved state. Live origins keep separate local storage. The directory itself is
not included in any host backup, and removing an entry does not delete its saved
preferences. Native embedded website cookies stay shared on the device.

PWA clients retain their directory locally and transfer that directory alone in a
fragment when navigating between origins. The fragment is consumed and removed
before shell initialization. Disconnect uses a standalone same-origin picker so
host connections stop. Native mode provides a picker even while the server is down;
a PWA’s cross-origin navigation remains subject to the browser’s standalone scope.

### System top-edge gestures

The notification and quick-settings pull-down panes have been removed on every
viewport, including iPhone and iPad. Their rendering, gesture actions, notification
mute/dismiss state and styles are gone. Home still shows Herd attention summaries,
and Settings remains a regular app. The middle of the in-app top bar still opens
the launcher; pulling down at either corner does nothing in the shell. Native
build 35 defers only the bottom edge, letting iOS handle its top-edge gestures
without the app’s previous extra swipe requirement.

## Desktop app

The desktop client in `desktop/` runs on Linux, macOS, and Windows, including the host machine itself. It is an Electron window that loads the selected host’s `/native/` shell and answers the same bridges as the iPhone and Android apps.

- **Hosts.** A fresh install opens the bundled host picker, which keeps its inline Add form on desktop. `--host=<address>` or `OMARCHY_REMOTE_URL` seeds and selects a host, like the configured URL in the phone apps. Hosts, the device ID, and per-host setting snapshots live in the app’s user-data folder, never on a host. An unreachable host, or one that answers with an HTTP error, returns to the picker with the reason.
- **Keys.** Linux and Windows builds have no menu bar, so every key reaches the shell, including Ctrl+Alt spellings of the ⌘ bindings. macOS keeps a minimal menu for Quit, Hide, Minimize, and editing keys, which the shortcut editor already reserves. Move window to workspace uses ⌘⌥ on macOS and ⌘⇧ (Ctrl+Alt+Shift) on Linux and Windows, where the desktop owns Super.
- **Embedded pages.** Browser tabs and pinned web apps open as separate pages placed over their tiles, with rounded corners, in a website profile separate from the shell. Pages get no host bridges. Links that open a new window stay in the page. Shell shortcuts typed in a page are forwarded to the shell; editing keys stay with the page. Ctrl+F opens a find bar with match counts. Dark, zoom, back and forward, reload, and Home previews work as on iPhone. Camera, microphone, location, notification, and clipboard-read requests ask first. Page opacity for unfocused windows is not applied.
- **Files and widgets.** Saving from Files or Builds opens the system save dialog. The weather widget reads the temperature unit from the system locale; location is unavailable on desktop, so choose a city. Builds lists no installable builds for desktop yet.
- **App windows.** `--app=<key>` opens one catalog app in its own window, loaded as `/native/?app=<key>`. Launching the client again hands the request to the running process, which opens that app's window or focuses it if it is already open; without `--app` it opens or focuses the full shell. Each window remembers its size and position. Settings › app windows lists every app with **open** and, on Linux, **launcher**, which writes or removes `~/.local/share/applications/omarchy-remote-<key>.desktop` so the app appears in the desktop's application launcher. Switching hosts reloads every window on the new host.
- **Packages.** `npm run dist:linux` in `desktop/` builds an AppImage and a pacman package. The packages include only the host picker and Dark Reader from the web bundle; the shell always comes from the host.

## Single-app windows

Loading the shell with `?app=<key>` (for example `/native/?app=herdr`) shows only that app, filling the window. There is no top bar, Home, workspace frame, wallpaper, home indicator, Expo, launcher or window management, and the app's own keys and controls are unchanged. The layout is always the 1:1 desk layout, even in a narrow window. Workspace, window and launcher shortcuts and gestures do nothing; opening another app, for example Files' Terminal here, opens it in its own window (a desktop window in the desktop client, a new tab in a browser) and leaves this window's app alone. Closing the app, for example when its shell exits, closes the window. A single-app window never restores or saves the shell's workspace layout; it reads only your shortcut overrides. App state such as Herdr's selected pane, drafts and host sessions is shared with the full shell, so a Terminal window attaches to the same host shell. An unknown key says so instead of showing the shell. On a phone, open the host's address with `?app=<key>` in Safari and choose **Add to Home Screen**: the icon opens just that app, under its name, as its own web app beside the full shell. The page points to a manifest made for that app (`/manifest.webmanifest?app=<key>&name=<name>`, served by the development server; a static build keeps the shared one).

Settings runs as its own window too (`?app=settings`). The theme and wallpaper are device settings shared by every window on the device: choosing one in any Settings window repaints every other open window at once, whether a single-app window, the full shell, or another browser tab.

## Native build downloads

The host's `/builds/` page lists published iPhone/iPad builds with release notes, source revision, profile expiry, SHA-256 checksum, a direct IPA download, and an iOS manifest install link. Open it in Safari with Tailscale connected when away from the local network. Installation still requires a device covered by the signing profile and Developer Mode; hosting does not register new devices or renew signing. An available download is not proof that iOS accepted installation.

Already validated IPAs are published with `scripts/publish-native-build.py`; the catalog lives outside Git in `~/.local/share/omarchy-remote/builds` (override with `OMARCHY_BUILDS_DIR` for both publisher and server). Builds are retained by SHA-256, and re-publishing identical bytes updates notes without duplicating the entry. The server exposes only the page, catalog, publishing skill, IPA/APK packages and manifest files. No signing credentials or validation logs are published.

The dashboard includes a downloadable `omarchy-builds` agent skill. It ships with the repository so other hosts can use the same publishing workflow with their own addresses and signing identities.

**Builds** is also an app in the Omarchy Remote launcher and Home app picker. Pin it like any other app. Before the host has published anything, it presents a setup landing page with the downloadable `omarchy-builds` skill and instructions for the agent. Published builds replace that landing page with release notes and build details; Refresh checks for new publications. In native build 37 and later, **Install** hands the selected build to iOS for confirmation. The native bridge constructs the HTTPS manifest URL from the connected host and a validated build hash; pages cannot supply arbitrary install URLs. A successful handoff means iOS accepted the URL, not that installation completed. **Open in Safari** asks the app to open the connected host's `/builds/` dashboard in Safari, the only browser that installs iOS builds, even when another browser is the default (native build 38 and later). Older native builds reject that request and the button copies the dashboard link instead. Updating Omarchy Remote itself may close it while iOS replaces the app. The skill can be saved through the system share sheet (or copied if file sharing is unavailable). The standalone host dashboard remains available at `/builds/`.

Native visionOS builds are packaged with `scripts/package-ios-app.sh` and published with the same publishing script. The catalog labels them separately from iOS; the headset lists only visionOS builds. These downloads are installed through a paired Mac, so the dashboard does not offer an iOS manifest installer for them.

## Android host (in development)

The Android host reuses the same shell and Rust backend, with Android WebViews for embedded browsing and saved web apps. Phone-sized screens (under 600 dp on the shorter side) stay in portrait, like iPhone; tablets rotate freely and use the desk layout. Back, from the left edge or the Back button, steps back inside the current app first: a Herdr thread returns to its pane list, Files goes up a folder or closes a preview, and Browser and web apps go back in page history. With nothing left to go back to it returns to Home, and Back on Home leaves the app. The right edge moves to the next workspace. On Android 14 and later both behaviours cover the whole edge; on Android 11–13, which cannot tell the edges apart, the middle 200 dp of each edge (Android's limit for an app) is the shell's and the rest is Back. In the full-screen shell the first edge swipe also shows Android's system bars. Apps join in by giving their instance a `navigateBack()` that returns true when it handled Back, and a `navigateForward()` that retraces it for edge navigation. It has native host selection, on-device preference storage, keyboard focus and battery reporting. The development APK currently builds and launches on the Android emulator and can type into a real host terminal. Weather’s compass uses Android foreground location permission, reports denial or disabled services, and cancels pending lookups when changing hosts. A granted emulator lookup populated the live weather widget. Files uploads use Android’s document picker. Save… opens the system Save as dialog, with chunked transfer and background writing; no broad storage permission is required. Native browsing now supports Find with match counts, SPA history reporting, top-only toolbar reveal, and dark-mode toggling. Android hardware shortcuts use the shared action registry, including custom bindings, and reach the shell while embedded websites are focused. Ctrl+Alt is an alternative to plain Command/Super bindings on Android; clipboard commands remain native. When a host cannot load, the bundled shell runs under that host’s origin, retains local settings, and retries with bounded backoff while foregrounded. Returning from the background resumes host connections. Tablet layout validation, remaining browser interactions, and APK updates still require the implementation and verification recorded in [Android parity](android-parity.md). This is not yet a claim of complete Android support.

Device backups include the widget catalog history as well as the visible widget order. Restoring a backup therefore keeps intentionally hidden widgets hidden.

On Android, hardware typing immediately after an app-launch, window-focus, or workspace shortcut waits briefly for the validated native input focus transfer. A superseding shortcut, backgrounding, or a two-second timeout discards pending input rather than delivering it to a different window. Terminal then uses its existing connection-startup input buffer.

Android Back dismisses visible keyboard input first, then launcher/Expo/shortcut overlays, then navigates the focused website’s history. At the root it backgrounds the task, preserving workspaces for resume. WebViews route Back before the input method only when the keyboard is not visible, so keyboard dismissal remains native.

Android Browser supports whole-document zoom from 25% to 500%, including images and layout, with reset and reload persistence. The Android host uses CSS root zoom rather than text-only scaling; viewport media-query breakpoints remain unchanged.

On Android with a hardware keyboard, selecting a Browser or saved web-app window transfers native keyboard focus to its page. Hiding or deselecting it releases focus; repeated layout animation updates do not steal focus from page controls.

The Builds catalog also accepts signed Android APKs. Native devices see builds for their own platform; the web dashboard offers both APK downloads and iOS manifests. Android Install verifies a content-addressed download, package identity, minimum API, signing identity, and version before opening the system confirmation. Installation-source permission is requested only after choosing Install; return and retry after granting it. The server serves APKs with their Android package MIME type. Publishing uses the existing script and agent skill, preserving older iOS catalog entries.

Android’s full-screen phone layout uses native IME insets instead of relying on viewport shrinkage, keeping message input and controls above the keyboard. An explicit dismissal also keeps a subsequent hardware-focus reconciliation from reopening it after Send. Message-mode Ctrl editing shortcuts operate on the local draft, while direct-key mode and the explicit Ctrl tool preserve host control sequences. Switching pane drafts ends the old editor session so composition and word suggestions do not remain attached to the previous pane.

Android native browser verification covers immediate keyboard-driven Terminal launch from a website, keeping subsequent input in the new terminal. Website links requesting a new window open inline in the embedded view, retain their same-site session cookies, and support Back without leaving the app.

Android file selection supports multiple files in Files and Herdr. The native wrapper reads all selected document URIs instead of relying on older WebView parsers that only read a single URI; cancelling still returns no files. Files selections can be saved as ZIP archives through Android’s document picker.

Android’s file action offers **Save to device** and **Share…**. Save uses the document picker; Share opens Android’s share sheet with the original filename and MIME type and a temporary read-only content URI. Cancelling the initial choice aborts cleanly. The app reports handing the file to the share sheet, not delivery by the recipient app. Shared copies remain in private cache for asynchronous readers; later startups remove copies older than one day.

Android’s end-to-end Browser check uses a separate Vivaldi profile and native messaging bridge. Navigation in the embedded page updates the exact desktop tab, while the close-tab shortcut closes that tab and leaves the Browser app window open. Native saved-host checks cover unsafe address rejection, returning to the picker after a disconnected restart, and preserving preferences within their host scope.

Programmatically focused app containers use the existing themed active-window border, avoiding a second square focus outline inside rounded windows on Android. Focus styling on buttons and text fields is unchanged.

Android rejects invalid host certificates for both WebView requests and automatic reconnect probes. The bundled interface remains available without accepting the certificate, including the saved-host picker and host-scoped local preferences. The native host dialog and saved-host connection row are covered by the untrusted-HTTPS emulator check.

Android Herdr input has an emulator check for real Gboard taps and keyboard Send, including the resulting host output, cleared draft and dismissed keyboard. Predictive correction and composing-script behavior remain separate Android verification work.

Android saved web apps retain their session cookies and device catalog/pins after process death, including when the catalog cannot be fetched. Their native lifecycle check uses an isolated catalog, follows new-window links inline, returns through Android Back and uninstalls the fixture. Websites without an authored background use the browser's white canvas so default black text remains legible; the surrounding shell stays themed.

Android tablet verification includes two independent embedded web apps: native page dimensions follow their tiles after divider dragging, Expo hides the full-size native surfaces and shows page previews, and leaving Expo restores the page dimensions. The same test checks app/session persistence after process death on the tablet viewport.

Android tablet Herdr keeps the composer above the software keyboard while retaining visible terminal output. Native verification waits for the keyboard animation to settle before checking the bounds and capturing the screen, then exercises draft switching, clipboard editing, image attachment, process-death recovery and sending to isolated test shells.

Android release APKs use an explicitly configured private signing key. Release builds disable debugging, require HTTPS, and open the saved-host picker. The release emulator fixture verifies signature continuity and saved-host retention across an in-place version update under a separate test identity.

Android shortcut labels distinguish `Ctrl+Alt` aliases from combinations requiring a physical Meta key. Host switching is displayed as `Meta+Ctrl+number`, and resize combinations as `Meta+Alt+Shift+arrow`; the help sheet does not repeat Ctrl or show Apple-only system-key notes on Android. The actual bindings are unchanged.

Host navigation also saves the departing host’s final device-settings snapshot before replacing the shell, without waiting for the periodic preference mirror.

Android remembers the browser’s forced Dark preference on the device. Newly opened browser and saved-app views inherit it after relaunch, and the browser menu reflects the restored setting.

Android takes native shell focus at the start of a touch gesture, preserving the launcher search field for immediate typing after a swipe. Unmodified Escape is delivered to the active app before the input method can consume it; Android Back remains available to dismiss the software keyboard.

Android weather units follow the device’s regional temperature preference, including explicit Celsius/Fahrenheit overrides, with locale defaults when no override is set.

Android message input retains native Gboard autocorrection and clipboard Undo. Emulator checks cover real touch typing and finger scrolling in Herdr and Terminal using isolated sessions.

Android update validation covers wrong package and signing-key rejection even when the download checksum is valid, plus cancellation and successful installation.

Signed release validation also connects to a real private HTTPS host and verifies live Home survives an in-place update. The userdebug emulator’s forced WebView debugging is recorded separately from the release APK’s nondebuggable configuration.

Android embedded pages keep square top corners beneath visible browser controls and round all corners when the controls are hidden or the page is a saved web app. Native scroll handling follows the toolbar visibility supplied by the shell.
