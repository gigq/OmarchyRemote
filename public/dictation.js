/* Shared audio capture; host adapters return text, never terminal keystrokes. */
(() => {
  const { node, button } = HyprlandUtil;
  let active = null;
  // PCM v1 frames: u32 little-endian byte length, mono 24 kHz PCM16, zero EOF.
  // Schedule on one audio clock so network boundaries never become audible gaps.
  class SpeechStream {
    constructor(context, signal, started) {
      this.context = context;
      this.signal = signal;
      this.started = started;
      this.sources = new Set();
      this.nextTime = 0;
      this.drained = new Promise(resolve => (this.resolve = resolve));
      this.cancel = () => this.stop();
      signal.addEventListener('abort', this.cancel, { once: true });
      this.stateChanged = () => {
        if (context.state === 'running') return;
        this.interrupted = true;
        this.stop();
      };
      context.addEventListener('statechange', this.stateChanged);
    }
    stop() {
      this.stopped = true;
      this.reader?.cancel().catch(() => {});
      for (const source of this.sources) {
        source.onended = null;
        source.stop();
        source.disconnect();
      }
      this.sources.clear();
      this.resolve();
    }
    schedule(bytes) {
      this.signal.throwIfAborted();
      const samples = bytes.byteLength / 2;
      const buffer = this.context.createBuffer(1, samples, 24000);
      const channel = buffer.getChannelData(0);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      source.onended = () => {
        source.disconnect();
        this.sources.delete(source);
        if (this.complete && !this.sources.size) this.resolve();
      };
      this.sources.add(source);
      this.nextTime = Math.max(this.nextTime, this.context.currentTime + 0.06);
      this.startTime ??= this.nextTime;
      source.start(this.nextTime);
      this.nextTime += buffer.duration;
      this.started();
    }
    // How far playback is, 0 to 1. Until the stream ends its length is what has arrived or
    // `estimate` seconds, whichever is longer.
    progress(estimate) {
      if (this.startTime === undefined) return 0;
      const played = this.context.currentTime - this.startTime;
      const length = this.nextTime - this.startTime;
      return Math.min(
        1,
        Math.max(0, played / (this.complete ? length : Math.max(length, estimate)))
      );
    }
    async play(response) {
      this.reader = response.body.getReader();
      let pending = new Uint8Array(0);
      let ended = false;
      let total = 0;
      try {
        while (true) {
          this.signal.throwIfAborted();
          const { done, value } = await this.reader.read();
          this.signal.throwIfAborted();
          if (done) break;
          const bytes = new Uint8Array(pending.length + value.length);
          bytes.set(pending);
          bytes.set(value, pending.length);
          let offset = 0;
          while (offset + 4 <= bytes.length) {
            if (ended) throw Error('Unexpected data after speech ended.');
            const size = new DataView(bytes.buffer).getUint32(offset, true);
            if (size > 2 * 1024 * 1024 || size % 2) throw Error('Invalid speech audio.');
            if (offset + 4 + size > bytes.length) break;
            offset += 4;
            if (!size) {
              ended = true;
              continue;
            }
            total += size;
            if (total > 32 * 1024 * 1024) throw Error('Speech audio is too large.');
            this.schedule(bytes.subarray(offset, offset + size));
            offset += size;
          }
          pending = bytes.slice(offset);
        }
        if (this.interrupted) throw Error('Audio was interrupted. Tap Read to resume.');
        if (!ended || pending.length || !total) throw Error('Speech stream ended unexpectedly.');
        this.complete = true;
        if (!this.sources.size) this.resolve();
        await this.drained;
        this.signal.throwIfAborted();
        if (this.interrupted) throw Error('Audio was interrupted. Tap Read to resume.');
      } finally {
        this.signal.removeEventListener('abort', this.cancel);
        this.context.removeEventListener('statechange', this.stateChanged);
        this.stop();
      }
    }
  }
  const herdrPath = (pane, suffix) => '/api/herdr/panes/' + encodeURIComponent(pane) + '/' + suffix;
  // Where Voice mode reads a thread's latest reply, speaks it, and sends a recording. Herdr's
  // threads are agent panes; another app passes its own (Chat sends through its composer).
  const herdrEndpoints = {
    latest: async (voice, pane) => (await voice.request(herdrPath(pane, 'response'))).json(),
    speech: pane => herdrPath(pane, 'speech'),
    send: (voice, pane, text, session) =>
      voice.request(herdrPath(pane, 'voice-input'), {
        method: 'POST',
        body: JSON.stringify({ text, session }),
      }),
  };
  class Voice {
    constructor(dictation, root, outputTools) {
      this.dictation = dictation;
      this.epoch = 0;
      this.player = new Audio();
      this.player.preload = 'auto';
      this.row = node('div', 'herdr-voice-status');
      this.row.hidden = true;
      this.replay = button('Read', () => this.readLast(), 'keycap small');
      this.stop = button('Stop', () => this.stopPlayback(), 'keycap small');
      this.stop.setAttribute('aria-label', 'Stop speaking');
      this.stop.hidden = true;
      this.message = node('span', 'remote-status');
      this.message.setAttribute('role', 'status');
      this.dismiss = button(
        '×',
        () => {
          this.row.hidden = true;
        },
        'keycap small'
      );
      this.dismiss.setAttribute('aria-label', 'Dismiss voice notification');
      this.row.append(this.message, this.dismiss);
      outputTools.append(this.replay, this.stop);
      root.append(this.row);
      this.player.onended = () => {
        if (!this.isAnswerAudio() || !this.player.ended) return;
        this.stop.hidden = true;
        this.reading('');
        this.status(this.enabled ? 'Ready to talk' : '', false);
      };
      this.player.onerror = () => {
        // Warm-up and cleared/replaced sources can report late media events.
        if (!this.isAnswerAudio() || !this.player.error || this.player.error.code === 1) return;
        this.stop.hidden = true;
        this.reading('');
        this.status('Audio playback failed. Try Read.');
      };
    }
    isAnswerAudio() {
      return !!this.audioURL && this.player.currentSrc === this.audioURL;
    }
    status(text, visible = true) {
      this.message.textContent = text;
      this.row.hidden = !text || !visible;
      this.replay.title = text || 'Read the last response';
      this.replay.setAttribute('aria-busy', String(text === 'Generating speech on host…'));
      this.dictation.changed?.();
    }
    async request(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: { 'X-Hyprland-Client': '1', 'Content-Type': 'application/json' },
        signal: AbortSignal.any([
          this.abort.signal,
          ...(options.signal ? [options.signal] : []),
          AbortSignal.timeout(200000),
        ]),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw Error(data.error || 'Voice connection failed.');
      }
      return response;
    }
    latest(pane) {
      return this.dictation.endpoints.latest(this, pane);
    }
    // Tells the host view the text being read aloud and a function giving how far along it is,
    // from 0 to 1, or null once it stops.
    reading(text, progress) {
      this.dictation.speaking?.(text ? { text, progress } : null);
    }
    // Reading through the answer element, as far as its audio has played.
    readingAnswer() {
      this.reading(this.speechText, () =>
        this.player.duration > 0 ? this.player.currentTime / this.player.duration : 0
      );
    }
    stopPlayback() {
      ++this.playGeneration;
      this.playAbort?.abort();
      this.streamPlayer?.stop();
      this.streamPlayer = null;
      this.speaking = false;
      this.player.pause();
      this.needsPlay = false;
      this.reading('');
      this.replay.textContent = 'Read';
      this.stop.hidden = true;
      if (this.audioURL) URL.revokeObjectURL(this.audioURL);
      this.audioURL = null;
      this.player.removeAttribute('src');
      this.status(this.enabled ? 'Ready to talk' : '', false);
    }
    reset(keepMode = false) {
      this.dictation.cancelHolds?.forEach(cancel => cancel());
      ++this.epoch;
      this.enabled = keepMode;
      // Whether Voice mode reads replies aloud; a quiet Voice mode only sends recordings.
      if (!keepMode) this.readAloud = false;
      this.ready = false;
      this.autoRead = false;
      this.retryAt = 0;
      this.retryDelay = 0;
      this.pane = null;
      this.session = null;
      this.loading = false;
      this.speaking = false;
      clearTimeout(this.timer);
      this.abort?.abort();
      this.abort = new AbortController();
      this.playGeneration = 0;
      this.stopPlayback();
      this.status('', false);
      this.dictation.syncMicrophone();
    }
    // Prime this audio element during a user gesture. Platforms that still block playback
    // get an explicit Play answer button; never silently drop a completed answer.
    unlock() {
      try {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (Context) {
          this.audioContext ||= new Context();
          this.audioContext.resume().catch(() => {});
        }
      } catch {
        // Complete-WAV playback remains available without Web Audio.
      }
      if (this.player.src) return;
      this.player.src =
        'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
      this.player.play().catch(() => {});
    }
    async toggle(readAloud = true) {
      if (this.enabled || this.loading) return this.reset();
      this.reset();
      this.readAloud = readAloud;
      this.autoRead = true;
      if (readAloud) this.unlock();
      await this.followThread();
    }
    // Holding the floating microphone switches reading replies aloud; it starts with the next reply.
    async setReadAloud(on) {
      if ((!this.enabled && !this.loading) || on === this.readAloud) return;
      const epoch = this.epoch;
      if (on) {
        this.unlock();
        try {
          const provider = await (await this.request('/api/voice')).json();
          if (!provider.available) throw Error(provider.message);
        } catch (e) {
          if (epoch === this.epoch) this.status(e.message);
          return;
        }
        if (epoch !== this.epoch) return;
      } else this.stopPlayback();
      this.readAloud = on;
      this.dictation.syncMicrophone();
      this.status(on ? 'Replies read aloud' : 'Replies stay silent', false);
    }
    // The same thread under a new id, such as a new chat once the host names it: Voice keeps
    // following it, and takes the session from its next reading.
    retarget(target) {
      if (!this.enabled && !this.loading) return;
      this.pane = target;
      this.session = null;
      if (this.enabled && !this.loading) {
        clearTimeout(this.timer);
        this.poll();
      }
    }
    changeThread() {
      const keepMode = this.enabled || this.loading;
      this.reset(keepMode);
      if (!keepMode) return;
      // Switching drops capture/transcription rather than delivering audio to either thread.
      this.dictation.cancel();
      if (this.dictation.getTarget()) this.followThread();
    }
    async followThread() {
      const epoch = this.epoch;
      const pane = this.dictation.getTarget();
      if (!pane) return;
      this.loading = true;
      this.dictation.syncMicrophone();
      this.status('Checking voice…', false);
      try {
        if (this.readAloud) {
          const provider = await (await this.request('/api/voice')).json();
          if (!provider.available) throw Error(provider.message);
        }
        const value = await this.latest(pane);
        if (epoch !== this.epoch || pane !== this.dictation.getTarget()) return;
        this.pane = pane;
        this.session = value.session;
        this.seen = new Set([
          value.answer?.id,
          ...(value.updates || []).map(update => update.id),
          ...(value.paragraphs || []).map(part => part.id),
        ]);
        this.enabled = true;
        this.ready = true;
        this.dictation.syncMicrophone();
        this.status(
          this.readAloud
            ? 'Voice on · recordings send automatically'
            : 'Voice on · recordings send automatically · hold Talk to read replies aloud',
          false
        );
        this.poll();
      } catch (e) {
        if (epoch !== this.epoch) return;
        // A tap on the microphone for a thread Voice cannot follow (a shell, say) is ordinary
        // dictation into the draft; only asking for Voice reports why.
        if (this.readAloud) this.status(e.message);
        else this.reset();
      } finally {
        if (epoch === this.epoch) {
          this.loading = false;
          this.dictation.syncMicrophone();
        }
      }
    }
    async poll() {
      const epoch = this.epoch;
      try {
        if (!this.enabled || this.pane !== this.dictation.getTarget()) return;
        if (!document.hidden && this.dictation.state === 'idle' && !this.speaking) {
          const value = await this.latest(this.pane);
          if (epoch !== this.epoch || this.dictation.state !== 'idle' || document.hidden) return;
          if (this.session === null) this.session = value.session;
          else if (value.session !== this.session) {
            this.changeThread();
            return;
          }
          // Keep fetching while audio plays, but never interrupt it with the next update.
          // The host retains this turn's prose so updates arriving during playback stay ordered.
          if (!this.readAloud) {
            // Quiet: what arrives now counts as heard, so reading aloud starts with what follows.
            for (const message of [
              value.answer,
              ...(value.updates || []),
              ...(value.paragraphs || []),
            ])
              if (message?.id) this.seen.add(message.id);
          } else if (this.autoRead && (!this.audioURL || this.player.paused) && !this.needsPlay) {
            const messages = value.paragraphs ? [...value.paragraphs] : [...(value.updates || [])];
            if (!value.paragraphs && !value.working && value.answer) messages.push(value.answer);
            const next = messages.find(message => message.id && !this.seen.has(message.id));
            if (next && Date.now() >= (this.retryAt || 0)) {
              // Batch paragraphs already available into one synthesis request.
              // Later paragraphs can join the next request without repeating these.
              const batch = [next];
              let length = next.text?.length || 0;
              if (value.paragraphs) {
                for (const message of messages.slice(messages.indexOf(next) + 1)) {
                  if (this.seen.has(message.id)) continue;
                  length += message.text?.length || 0;
                  if (batch.length >= 32 || length > 12000) break;
                  batch.push(message);
                }
              }
              batch.forEach(message => this.seen.add(message.id));
              const spoken = await this.speak(
                this.pane,
                next.id,
                batch.map(message => message.id),
                true,
                batch.map(message => message.text || '').join('\n\n')
              );
              // A failed batch goes back in the queue, retried after a growing delay so a
              // broken speech provider is not run every second. Stop still skips it.
              if (spoken === false && epoch === this.epoch) {
                batch.forEach(message => this.seen.delete(message.id));
                this.retryDelay = Math.min(60000, (this.retryDelay || 2500) * 2);
                this.retryAt = Date.now() + this.retryDelay;
              } else if (spoken) this.retryDelay = 0;
            }
          }
        }
      } catch (e) {
        if (epoch === this.epoch) this.status(e.message);
      } finally {
        if (epoch === this.epoch && this.enabled) this.timer = setTimeout(() => this.poll(), 1000);
      }
    }
    recordingStarted() {
      this.stopPlayback();
      this.dictation.input.saveDraft();
      // A tap starts recording while Voice is still getting ready; it sends if Voice comes up for
      // the same thread before the transcript arrives.
      return this.enabled || this.loading
        ? {
            epoch: this.epoch,
            pane: this.dictation.getTarget(),
            draft: this.dictation.input.draft,
          }
        : null;
    }
    async transcribed(context, text, recordingGeneration) {
      const input = this.dictation.input;
      if (
        !context ||
        context.epoch !== this.epoch ||
        !this.enabled ||
        !this.ready ||
        context.pane !== this.pane ||
        recordingGeneration !== this.dictation.generation
      )
        return;
      if (
        context.pane !== this.dictation.getTarget() ||
        context.draft.trim() ||
        input.draft !== text
      ) {
        this.status('Saved as a draft; review and send when ready.');
        return;
      }
      try {
        const latest = await this.latest(context.pane);
        if (
          context.epoch !== this.epoch ||
          recordingGeneration !== this.dictation.generation ||
          !this.enabled ||
          context.pane !== this.dictation.getTarget()
        )
          return;
        this.session ??= latest.session;
        if (latest.session !== this.session || input.draft !== text) {
          this.status('Saved as a draft; the conversation or composer changed.');
          return;
        }
        // Skip updates from work already underway; follow responses to this voice message.
        this.seen = new Set([
          latest.answer?.id,
          ...(latest.updates || []).map(update => update.id),
          ...(latest.paragraphs || []).map(part => part.id),
        ]);
        // Explicit REST acknowledgement; never retry a send after a lost connection.
        await this.dictation.endpoints.send(this, context.pane, text, this.session);
        if (input.id === context.pane && input.draft === text) {
          input.draft = '';
          input.field.value = '';
          input.storeDraft(context.pane, '');
          input.dismiss();
        }
        if (context.epoch === this.epoch) {
          this.autoRead = true;
          this.status('Sent · waiting for the answer', false);
        }
      } catch (e) {
        if (context.epoch === this.epoch)
          this.status('Could not confirm sending. Draft kept; check the thread before retrying.');
      }
    }
    async readLast() {
      if (this.dictation.state !== 'idle') {
        this.status('Finish dictation before playing an answer.');
        return;
      }
      if (this.needsPlay && this.audioURL && this.player.paused) {
        const epoch = this.epoch;
        const generation = this.playGeneration;
        try {
          await this.player.play();
          if (epoch !== this.epoch || generation !== this.playGeneration) return;
          this.stop.hidden = false;
          this.replay.textContent = 'Read';
          this.needsPlay = false;
          this.readingAnswer();
          this.status('Speaking', false);
        } catch {
          if (epoch !== this.epoch || generation !== this.playGeneration) return;
          this.status('Playback unavailable. Try again.');
        }
        return;
      }
      this.abort ||= new AbortController();
      this.stopPlayback();
      this.unlock();
      const epoch = this.epoch;
      const generation = this.playGeneration;
      const pane = this.dictation.getTarget();
      try {
        const value = await this.latest(pane);
        if (
          epoch !== this.epoch ||
          generation !== this.playGeneration ||
          pane !== this.dictation.getTarget() ||
          this.dictation.state !== 'idle'
        )
          return;
        if (!value.answer?.id) throw Error('No completed response yet.');
        await this.speak(pane, value.answer.id, [value.answer.id], false, value.answer.text);
      } catch (e) {
        if (epoch === this.epoch) this.status(e.message);
      }
    }
    // Resolves false when speech failed, true when it played or awaits Play answer, and
    // undefined when Stop or a newer request superseded it.
    async speak(pane, id, ids = [id], automatic = false, text = '') {
      this.stopPlayback();
      this.speechText = text;
      const epoch = this.epoch;
      const generation = this.playGeneration;
      this.speaking = true;
      this.playAbort = new AbortController();
      const signal = this.playAbort.signal;
      this.stop.hidden = false;
      this.status('Generating speech on host…', false);
      try {
        const response = await this.request(this.dictation.endpoints.speech(pane), {
          method: 'POST',
          body: JSON.stringify({
            response_id: id,
            response_ids: ids,
            stream: this.audioContext?.state === 'running',
          }),
          signal,
        });
        signal.throwIfAborted();
        if (
          response.headers.get('Content-Type')?.startsWith('application/vnd.omarchy.pcm-stream')
        ) {
          if (this.audioContext?.state !== 'running') {
            throw Error('Audio is paused. Tap Read to resume.');
          }
          // Speech runs at about 15 characters a second until the stream gives its length.
          const estimate = text.length / 15;
          const stream = new SpeechStream(this.audioContext, signal, () => {
            if (!this.speechStarted) this.reading(text, () => stream.progress(estimate));
            this.speechStarted = true;
            this.status('Speaking', false);
          });
          this.speechStarted = false;
          this.streamPlayer = stream;
          await stream.play(response);
          if (epoch !== this.epoch || generation !== this.playGeneration) return;
          this.streamPlayer = null;
          this.reading('');
          this.stop.hidden = true;
          this.status(this.enabled ? 'Ready to talk' : '', false);
          return true;
        }
        const blob = await response.blob();
        if (
          epoch !== this.epoch ||
          generation !== this.playGeneration ||
          pane !== this.dictation.getTarget()
        )
          return;
        this.audioURL = URL.createObjectURL(blob);
        this.player.src = this.audioURL;
        try {
          await this.player.play();
          if (epoch !== this.epoch || generation !== this.playGeneration) return;
          this.readingAnswer();
          this.status('Speaking', false);
          return true;
        } catch (e) {
          if (epoch !== this.epoch || generation !== this.playGeneration) return;
          if (e.name !== 'NotAllowedError') {
            this.stop.hidden = true;
            this.status('Audio playback failed. Try Read.');
            return false;
          }
          this.status('Answer ready · tap Play answer', false);
          this.replay.textContent = 'Play answer';
          this.needsPlay = true;
          this.stop.hidden = true;
          return true;
        }
      } catch (e) {
        if (epoch === this.epoch && generation === this.playGeneration) {
          this.playAbort.abort();
          this.streamPlayer?.stop();
          this.streamPlayer = null;
          this.reading('');
          this.status(e.message + (automatic ? ' Retrying shortly.' : ' Use Read to retry.'));
          this.stop.hidden = true;
          return false;
        }
      } finally {
        if (epoch === this.epoch && generation === this.playGeneration) this.speaking = false;
      }
    }
    dispose() {
      this.reset();
      this.audioContext?.close().catch(() => {});
      this.row.remove();
      this.replay.remove();
      this.stop.remove();
    }
  }

  class Dictation {
    constructor(input, getTarget, overlayRoot, outputTools, options = {}) {
      this.input = input;
      this.getTarget = getTarget;
      this.endpoints = options.endpoints || herdrEndpoints;
      this.group = options.group || 'Herdr';
      // Called when Voice's controls or status change, so the host view can show them.
      this.changed = options.changed;
      // Called with what Voice reads aloud and its progress, or null when it stops.
      this.speaking = options.speaking;
      this.state = 'idle';
      this.generation = 0;
      this.button = button('', () => this.toggle(), 'keycap herdr-attach dictation-button');
      this.microphoneIcon =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
      this.headphonesIcon =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="4" height="9" rx="2"/><rect x="17" y="12" width="4" height="9" rx="2"/></svg>';
      this.button.innerHTML = this.microphoneIcon;
      this.control = this.button;
      this.escape = e => {
        if (e.key !== 'Escape' || active !== this) return;
        this.cancel();
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      document.addEventListener('keydown', this.escape, true);
      this.floatingButton = button('', () => this.toggle(), 'herdr-voice-microphone');
      this.floatingIcon = node('span', 'herdr-voice-microphone-icon');
      this.floatingIcon.innerHTML = this.button.innerHTML;
      this.floatingCaption = node('span', 'herdr-voice-microphone-caption');
      // A speaker badge marks that replies are read aloud.
      this.floatingSpeaker = node('span', 'herdr-voice-speaker');
      this.floatingSpeaker.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';
      this.floatingButton.append(this.floatingIcon, this.floatingCaption, this.floatingSpeaker);
      this.floatingButton.hidden = true;
      this.cancelHolds = [];
      this.bindMicrophone(this.button);
      this.bindMicrophone(this.floatingButton);
      overlayRoot.append(this.floatingButton);
      this.notice = node('div', 'dictation-notice');
      this.label = node('span');
      this.label.setAttribute('role', 'status');
      this.dismissButton = button('×', () => this.cancel(), 'keycap small');
      this.dismissButton.setAttribute('aria-label', 'Dismiss dictation error');
      this.retryButton = button('Retry', () => this.transcribe(), 'keycap small');
      this.notice.append(this.label, this.retryButton, this.dismissButton);
      overlayRoot.append(this.notice);
      this.background = () => {
        if (document.hidden) this.cancelHolds.forEach(cancel => cancel());
        if (document.hidden) this.voice.stopPlayback();
        if (document.hidden && ['starting', 'recording'].includes(this.state)) this.cancel();
      };
      document.addEventListener('visibilitychange', this.background);
      this.voice = new Voice(this, overlayRoot, outputTools);
      this.voice.reset();
      this.paint('idle');
    }
    bindMicrophone(control) {
      let press = null;
      let holdTimer;
      let suppressClick = false;
      const cancelHold = () => {
        clearTimeout(holdTimer);
        if (press) suppressClick = true;
        press = null;
      };
      this.cancelHolds.push(cancelHold);
      control.style.touchAction = 'none';
      control.setAttribute(
        'aria-description',
        'Tap to record or finish. Hold to toggle Voice mode. With a keyboard, press Shift+Enter.'
      );
      control.onpointerdown = e => {
        if (e.button !== 0 || !e.isPrimary) return;
        e.preventDefault();
        e.stopPropagation();
        suppressClick = false;
        clearTimeout(holdTimer);
        press = { x: e.clientX, y: e.clientY };
        const pane = this.getTarget();
        // Prime playback in the touch gesture; the hold callback runs later.
        if (this.state === 'idle' && (!this.voice.enabled || !this.voice.readAloud))
          this.voice.unlock();
        control.setPointerCapture(e.pointerId);
        holdTimer = setTimeout(() => {
          const shouldToggle =
            press && control.isConnected && !document.hidden && pane === this.getTarget();
          cancelHold();
          if (shouldToggle) this.hold(control);
        }, 550);
      };
      control.onpointermove = e => {
        if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) {
          cancelHold();
        }
      };
      control.onpointerup = e => {
        clearTimeout(holdTimer);
        press = null;
        if (control.hasPointerCapture(e.pointerId)) control.releasePointerCapture(e.pointerId);
      };
      control.onpointercancel = control.onlostpointercapture = cancelHold;
      control.onclick = e => {
        e.stopPropagation();
        if (suppressClick && e.detail !== 0) {
          suppressClick = false;
          return;
        }
        if (control !== this.button) this.toggle();
        else if (this.voice.enabled || this.voice.loading) this.toggleVoice();
        else this.talk();
      };
      control.oncontextmenu = e => {
        e.preventDefault();
        e.stopPropagation();
        // Touch context menus must not toggle twice after a long press.
        if (e.pointerType === 'mouse') this.hold(control);
      };
      control.onkeydown = e => {
        if (e.key !== 'Enter' || !e.shiftKey) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) this.hold(control);
      };
    }
    // Holding the bar microphone turns Voice mode on with replies read aloud (or off); holding the
    // floating one switches reading aloud while Voice mode stays on.
    hold(control) {
      if (control === this.floatingButton && (this.voice.enabled || this.voice.loading))
        this.voice.setReadAloud(!this.voice.readAloud);
      else this.toggleVoice();
    }
    // A tap on the bar microphone records at once in a quiet Voice mode: the big button takes over,
    // recordings send themselves, and replies are not read aloud.
    talk() {
      // A dictation started from the keyboard shortcut finishes as one.
      if (this.state === 'recording') {
        this.toggle();
        return;
      }
      if (!['idle', 'error'].includes(this.state) || !this.getTarget()) return;
      this.voice.toggle(false);
      this.toggle();
    }
    toggleVoice() {
      // While Voice is still starting, the bar microphone already means "turn Voice off".
      if (this.voice.enabled || this.voice.loading) {
        this.cancel();
        this.voice.reset();
        return;
      }
      if (!['idle', 'error'].includes(this.state)) return;
      this.voice.toggle();
    }
    paint(state, message = '') {
      this.state = state;
      this.notice.hidden = state !== 'error';
      this.label.textContent = message;
      this.retryButton.hidden = state !== 'error' || !this.audio;
      this.syncMicrophone();
    }
    syncMicrophone() {
      const enabled = !!this.voice?.enabled || !!this.voice?.loading;
      const readAloud = enabled && !!this.voice.readAloud;
      const recording = this.state === 'recording';
      const busy = ['starting', 'transcribing'].includes(this.state);
      this.button.innerHTML = readAloud ? this.headphonesIcon : this.microphoneIcon;
      this.button.dataset.mode = enabled ? 'voice' : 'dictation';
      this.button.dataset.state = enabled ? 'idle' : this.state;
      this.button.setAttribute(
        'aria-label',
        enabled ? 'Turn off Voice mode' : recording ? 'Stop dictation' : 'Start dictation'
      );
      this.button.title = enabled
        ? 'Voice mode on · tap to turn off'
        : recording
          ? 'Stop dictation'
          : 'Talk · hold to have replies read aloud · ⌘⌃X dictates';
      this.button.setAttribute(
        'aria-description',
        enabled
          ? 'Tap to turn off Voice mode and stop recording or playback.'
          : 'Tap to talk: records now and sends when you finish. Hold for Voice mode with replies read aloud, or press Shift+Enter.'
      );
      this.button.setAttribute('aria-pressed', String(enabled || recording));
      this.button.disabled = busy && !enabled;
      this.button.setAttribute('aria-busy', String(busy && !enabled));
      const loading = !!this.voice?.loading;
      this.floatingButton.hidden = !enabled && !loading;
      // While Voice starts, Talk still records (it sends once Voice is ready) and a hold still
      // switches reading aloud; only a Voice that failed has nothing to offer.
      this.floatingButton.disabled = busy || (!this.voice?.ready && !loading && !recording);
      this.floatingButton.dataset.readAloud = String(readAloud);
      this.floatingSpeaker.hidden = !readAloud;
      this.floatingButton.dataset.state = this.state;
      this.floatingButton.setAttribute(
        'aria-label',
        recording ? 'Stop dictation' : 'Start dictation'
      );
      this.floatingButton.setAttribute('aria-pressed', String(recording));
      this.floatingButton.setAttribute('aria-busy', String(busy));
      this.floatingButton.title = recording
        ? 'Tap to finish recording and send'
        : readAloud
          ? 'Tap to talk · hold to stop reading replies aloud'
          : 'Tap to talk · hold to read replies aloud';
      this.floatingButton.setAttribute(
        'aria-description',
        readAloud ? 'Replies are read aloud.' : 'Replies are not read aloud.'
      );
      this.floatingCaption.textContent = recording
        ? 'Send'
        : busy || this.voice?.loading
          ? 'Wait…'
          : !this.voice?.ready
            ? 'Unavailable'
            : 'Talk';
      this.changed?.();
    }
    async toggle() {
      if (this.voice.enabled && !this.voice.ready && this.state !== 'recording') return;
      if (this.state === 'recording') {
        this.stop();
        return;
      }
      if (['starting', 'transcribing'].includes(this.state) || !this.getTarget()) return;
      if (active && active !== this) active.cancel();
      active = this;
      this.target = this.getTarget();
      this.voiceContext = this.voice.recordingStarted();
      this.audio = null;
      const generation = ++this.generation;
      this.paint('starting', 'Opening microphone…');
      try {
        if (
          window.__HYPRLAND_NATIVE_FOCUS__ &&
          window.__OMARCHY_PLATFORM__ !== 'android' &&
          !window.__OMARCHY_DICTATION_CAPTURE__
        ) {
          throw Error('Update the Apple app to build 40 or newer to enable microphone recording.');
        }
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
          throw Error('Microphone capture is unavailable. Update the native app or use HTTPS.');
        const response = await fetch('/api/dictation', { headers: { 'X-Hyprland-Client': '1' } });
        if (!response.ok) throw Error('Cannot reach host dictation.');
        const provider = await response.json();
        if (!provider.available) throw Error(provider.message);
        if (generation !== this.generation) return;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (generation !== this.generation) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        this.stream = stream;
        const mimeType = [
          'audio/mp4',
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/ogg;codecs=opus',
        ].find(type => MediaRecorder.isTypeSupported(type));
        this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
        const chunks = [];
        let bytes = 0;
        this.recorder.ondataavailable = e => {
          if (e.data.size) chunks.push(e.data);
          bytes += e.data.size;
          if (bytes > 12 * 1024 * 1024) {
            this.cancel();
            this.paint('error', 'Recording is too large. Try a shorter recording.');
          }
        };
        this.recorder.onerror = () => {
          this.cancel();
          this.paint('error', 'Recording failed. Please try again.');
        };
        this.recorder.onstop = () => {
          if (generation !== this.generation) return;
          this.audio = new Blob(chunks, { type: this.recorder.mimeType });
          this.transcribe();
        };
        this.recorder.start(1000);
        this.paint('recording', 'Recording… Press again to transcribe.');
        // Leave room for recorder timing and container duration rounding on the host.
        this.timer = setTimeout(() => this.stop(), 119000);
      } catch (e) {
        if (generation !== this.generation) return;
        this.release();
        this.paint(
          'error',
          e.name === 'NotAllowedError'
            ? 'Microphone permission was denied. Allow it in device settings and try again.'
            : e.message
        );
      }
    }
    release() {
      clearTimeout(this.timer);
      this.stream?.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    stop() {
      if (this.recorder?.state === 'recording') this.recorder.stop();
      this.release();
      this.paint('transcribing', 'Transcribing on host…');
    }
    async transcribe() {
      const generation = this.generation;
      this.abort = new AbortController();
      this.paint('transcribing', 'Transcribing on host…');
      try {
        const response = await fetch('/api/dictation', {
          method: 'POST',
          headers: { 'X-Hyprland-Client': '1', 'Content-Type': this.audio.type },
          body: this.audio,
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(220000)]),
        });
        const data = await response.json();
        if (!response.ok || typeof data.text !== 'string')
          throw Error(data.error || 'Transcription failed.');
        if (generation !== this.generation) return;
        if (data.text.trim()) {
          this.input.insertDictation(this.target, data.text.trim());
          await this.voice.transcribed(this.voiceContext, data.text.trim(), generation);
        }
        if (generation !== this.generation) return;
        this.audio = null;
        this.paint(data.text.trim() ? 'idle' : 'error', 'No speech detected.');
        if (active === this) active = null;
      } catch (e) {
        if (generation === this.generation)
          this.paint('error', e.message || 'Transcription failed. Retry or dismiss.');
      }
    }
    cancel() {
      this.cancelHolds.forEach(cancel => cancel());
      ++this.generation;
      this.abort?.abort();
      if (this.recorder?.state === 'recording') this.recorder.stop();
      this.release();
      this.audio = null;
      this.paint('idle');
      if (active === this) active = null;
    }
    get actions() {
      return [
        {
          code: 'KeyX',
          meta: true,
          ctrl: true,
          label: 'Toggle dictation',
          group: this.group,
          run: () => this.toggle(),
        },
      ];
    }
    dispose() {
      this.cancel();
      document.removeEventListener('visibilitychange', this.background);
      this.voice.dispose();
      this.floatingButton.remove();
      document.removeEventListener('keydown', this.escape, true);
      this.control.remove();
      this.notice.remove();
    }
  }
  Dictation.settings = host => {
    const section = node('section', 'legend');
    section.append(node('span', 'legend-title', 'dictation'));
    const status = node('p', 'theme-note', 'Checking host transcription…');
    section.append(
      status,
      node(
        'p',
        'theme-note',
        'Herdr and Chat: microphone or ⌘⌃X to start/stop. Hold the microphone to toggle Voice mode (or Shift+Enter with the microphone focused). The host administrator can override Voxtype with OMARCHY_DICTATION_COMMAND.'
      )
    );
    host.append(section);
    fetch('/api/dictation', { headers: { 'X-Hyprland-Client': '1' } })
      .then(r => {
        if (!r.ok) throw Error();
        return r.json();
      })
      .then(data => {
        status.textContent = `${data.provider} · ${data.message}`;
      })
      .catch(() => {
        status.textContent = 'Host dictation unavailable.';
      });
  };
  window.HyprlandDictation = Dictation;
})();
