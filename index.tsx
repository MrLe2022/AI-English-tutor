/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Session,
} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

interface TranscriptEntry {
  speaker: 'You' | 'Model';
  text: string;
}

interface SavedConversation {
  id: number;
  date: string;
  transcript: TranscriptEntry[];
}

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = 'Choose a topic and press record to begin.';
  @state() error = '';
  @state() transcript: TranscriptEntry[] = [];
  @state() currentInputTranscription = '';
  @state() currentOutputTranscription = '';
  @state() showingSaved = false;
  @state() savedConversations: SavedConversation[] = [];
  @state() topic = 'general conversation';
  @state() topicInput = '';

  private client: GoogleGenAI;
  private session: Session;
  // FIX: Cast window to any to access webkitAudioContext for broader browser support.
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  // FIX: Cast window to any to access webkitAudioContext for broader browser support.
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();
  private isIntentionallyClosing = false;

  static styles = css`
    h1#app-title {
      position: absolute;
      top: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: white;
      text-shadow: 0 0 8px rgba(0, 0, 0, 0.7);
      margin: 0;
      font-size: 2.5rem;
      font-weight: 300;
      letter-spacing: 1.5px;
    }

    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: white;
      text-shadow: 0 0 4px black;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 20px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background-color 0.2s;

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button.text-button {
        width: auto;
        padding: 0 20px;
        font-size: 16px;
      }

      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      #startButton[disabled],
      #stopButton[disabled] {
        display: none;
      }
    }

    #topic-container {
      position: absolute;
      bottom: 20vh;
      left: 50%;
      transform: translateX(-50%);
      z-index: 10;
      display: flex;
      gap: 10px;
      padding: 10px;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 12px;
      backdrop-filter: blur(5px);
      align-items: center;
    }

    #topic-container input {
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: white;
      border-radius: 8px;
      padding: 10px 15px;
      font-size: 16px;
      outline: none;
      width: 300px;
    }

    #topic-container input::placeholder {
      color: rgba(255, 255, 255, 0.6);
    }

    #topic-container button {
      outline: none;
      border: none;
      color: white;
      border-radius: 8px;
      background: #2563eb;
      cursor: pointer;
      font-size: 16px;
      padding: 10px 20px;
      transition: background-color 0.2s;
      white-space: nowrap;
    }

    #topic-container button:hover {
      background: #1d4ed8;
    }

    #topic-container button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      background: rgba(100, 100, 100, 0.5);
    }

    #transcript-container {
      position: absolute;
      top: 15vh;
      left: 5vw;
      right: 5vw;
      bottom: 32vh;
      background: rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(5px);
      border-radius: 12px;
      color: white;
      font-family: 'Roboto', sans-serif;
      display: flex;
      flex-direction: column;
      padding: 20px;
      box-sizing: border-box;
      pointer-events: none;
    }

    #transcript {
      flex-grow: 1;
      overflow-y: auto;
      scroll-behavior: smooth;
    }

    #transcript .entry {
      margin-bottom: 12px;
      line-height: 1.5;
    }

    #transcript strong {
      display: block;
      margin-bottom: 4px;
      opacity: 0.7;
    }

    #saved-conversations-view {
      position: fixed;
      inset: 0;
      background: rgba(10, 10, 20, 0.98);
      color: white;
      z-index: 20;
      padding: 30px;
      overflow-y: auto;
      font-family: 'Roboto', sans-serif;
      display: flex;
      flex-direction: column;
    }

    #saved-conversations-view h2 {
      text-align: center;
      margin-top: 0;
    }

    .saved-list {
      flex-grow: 1;
    }

    .saved-entry {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 15px;
    }

    .saved-entry h3 {
      margin-top: 0;
      font-size: 1.1em;
    }

    .saved-entry p {
      margin: 0 0 10px 0;
      line-height: 1.4;
    }

    .saved-entry button,
    #saved-conversations-view > button {
      background: #2563eb;
      color: white;
      border: none;
      padding: 8px 12px;
      border-radius: 6px;
      cursor: pointer;
      transition: background-color 0.2s;
    }

    .saved-entry button {
      background: #dc2626;
    }

    .saved-entry button:hover {
      background: #b91c1c;
    }

    #saved-conversations-view > button {
      margin-top: auto;
      padding: 12px;
      font-size: 1em;
    }

    #saved-conversations-view > button:hover {
      background: #1d4ed8;
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  updated(changedProperties) {
    if (
      changedProperties.has('transcript') ||
      changedProperties.has('currentInputTranscription') ||
      changedProperties.has('currentOutputTranscription')
    ) {
      // FIX: Use this.renderRoot, the correct LitElement property for accessing the shadow DOM.
      // FIX: Replaced 'this.renderRoot' with 'this.shadowRoot?' to fix property not found error.
      const transcriptEl = this.shadowRoot?.querySelector('#transcript');
      if (transcriptEl) {
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
      }
    }
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    this.initSession();
  }

  private async initSession() {
    const model = 'gemini-2.5-flash-native-audio-preview-09-2025';
    const systemInstruction = `You are a friendly and encouraging English language tutor named Orb. Your goal is to help the user practice speaking about a specific topic.
The current topic is: "${this.topic}".

Your instructions are:
1.  Start the conversation by asking a simple, open-ended question about the topic.
2.  Engage in a natural, back-and-forth conversation with the user. Keep your turns relatively short to encourage the user to speak more.
3.  Listen carefully to the user's transcribed responses for grammatical errors, awkward phrasing, or vocabulary issues.
4.  When you notice a mistake, gently correct it. For example, you could say: "That's a good point. Just a small tip, instead of saying 'I feeled happy', you can say 'I felt happy'. 'Felt' is the past tense of 'feel'. Now, regarding happiness, what's something that always makes you smile?"
5.  Integrate your feedback smoothly into the conversation. Do not just list out errors. The conversation should feel natural, not like a test.
6.  If the user seems to be struggling or pauses for a long time, provide a hint, suggest a vocabulary word, or ask a simple follow-up question to keep the conversation flowing.
7.  Keep your tone positive and supportive. Your primary goal is to build the user's confidence in speaking English.
8.  Speak clearly and at a moderate pace. Avoid complex vocabulary or sentence structures unless the user is advanced.`;

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Ready to record.');
          },
          onmessage: async (message: LiveServerMessage) => {
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio) {
              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1,
              );
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () => {
                this.sources.delete(source);
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              this.currentInputTranscription += text;
            }
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              this.currentOutputTranscription += text;
            }

            if (message.serverContent?.turnComplete) {
              const fullInputTranscription = this.currentInputTranscription;
              const fullOutputTranscription = this.currentOutputTranscription;

              if (fullInputTranscription.trim()) {
                this.transcript = [
                  ...this.transcript,
                  {speaker: 'You', text: fullInputTranscription.trim()},
                ];
              }
              if (fullOutputTranscription.trim()) {
                this.transcript = [
                  ...this.transcript,
                  {speaker: 'Model', text: fullOutputTranscription.trim()},
                ];
              }
              this.currentInputTranscription = '';
              this.currentOutputTranscription = '';
            }

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            let errorMessage = 'An unknown error occurred';
            const errorSource = e.error || e.message;

            // Try to extract a meaningful message from various error shapes
            if (typeof errorSource === 'string') {
              errorMessage = errorSource;
            } else if (errorSource instanceof Error) {
              errorMessage = errorSource.message;
            } else if (
              errorSource &&
              typeof errorSource === 'object' &&
              'message' in errorSource
            ) {
              errorMessage = String(errorSource.message);
            }

            // Clean up common prefixes for better display.
            if (errorMessage.startsWith('Error: ')) {
              errorMessage = errorMessage.substring(7);
            }

            // Replace '[object Object]' which is unhelpful
            if (errorMessage.includes('[object Object]')) {
              errorMessage = 'An unexpected connection issue occurred.';
            }

            // Remove trailing period to prevent double periods in the final message.
            if (errorMessage.endsWith('.')) {
              errorMessage = errorMessage.slice(0, -1);
            }

            this.updateError(
              `Connection error: ${errorMessage}. Please reset the session.`,
              e,
            );
          },
          onclose: (e: CloseEvent) => {
            if (this.isIntentionallyClosing) {
              this.isIntentionallyClosing = false; // Reset flag
              console.log('Session closed intentionally.', e);
              return; // Do not treat as an error
            }
            let reason = e.reason || 'Connection closed unexpectedly';

            // Same cleanup logic as onerror for consistency
            if (reason.startsWith('Error: ')) {
              reason = reason.substring(7);
            }
            if (reason.endsWith('.')) {
              reason = reason.slice(0, -1);
            }

            this.updateError(
              `Session closed: ${reason}. You may need to start a new session.`,
              e,
            );
            this.isRecording = false; // Also update state
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
          },
          systemInstruction: systemInstruction,
        },
      });
    } catch (e) {
      this.updateError(
        'Failed to initialize the session. Please check your API key and network connection.',
        e as Error,
      );
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = '';
  }

  private updateError(msg: string, e?: Error | ErrorEvent | CloseEvent) {
    this.error = msg;
    console.error(msg, e);
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    this.inputAudioContext.resume();

    this.updateStatus('Requesting microphone...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Connecting to the session...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        this.session.sendRealtimeInput({media: createBlob(pcmData)});
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('🔴 Listening... Speak now.');
    } catch (err) {
      let userMessage = `Error starting microphone: ${err.message}`;
      if (err.name === 'NotAllowedError') {
        userMessage =
          'Microphone permission was denied. Please allow microphone access in your browser settings.';
      } else if (err.name === 'NotFoundError') {
        userMessage = 'No microphone was found on your device.';
      }
      this.updateError(userMessage, err as Error);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.updateStatus('Processing...');

    this.isRecording = false;

    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.updateStatus('Recording stopped. Press record to start again.');
  }

  private reset() {
    this.isIntentionallyClosing = true;
    this.session?.close();
    this.initSession();
    this.updateStatus('Resetting session...');
    this.transcript = [];
    this.currentInputTranscription = '';
    this.currentOutputTranscription = '';
  }

  private setTopic() {
    if (this.topicInput.trim()) {
      this.topic = this.topicInput.trim();
      this.updateStatus(`Topic set to: "${this.topic}". Ready to record.`);
      this.reset();
    }
  }

  private saveConversation() {
    if (this.transcript.length === 0) {
      return;
    }
    try {
      const saved = JSON.parse(
        localStorage.getItem('savedConversations') || '[]',
      );
      const newConversation = {
        id: Date.now(),
        date: new Date().toLocaleString(),
        transcript: this.transcript,
      };
      saved.push(newConversation);
      localStorage.setItem('savedConversations', JSON.stringify(saved));
      this.updateStatus('Conversation saved.');
    } catch (e) {
      this.updateError(
        'Could not save conversation. Your browser storage may be full.',
        e as Error,
      );
    }
  }

  private loadSavedConversations() {
    try {
      this.savedConversations =
        JSON.parse(
          localStorage.getItem('savedConversations') || '[]',
        ).reverse() ?? [];
    } catch (e) {
      this.updateError(
        'Could not load saved conversations. The data may be corrupted.',
        e as Error,
      );
      this.savedConversations = [];
    }
  }

  private toggleSavedView() {
    if (!this.showingSaved) {
      this.loadSavedConversations();
    }
    this.showingSaved = !this.showingSaved;
  }

  private deleteConversation(id: number) {
    try {
      let saved = JSON.parse(
        localStorage.getItem('savedConversations') || '[]',
      );
      saved = saved.filter((conv) => conv.id !== id);
      localStorage.setItem('savedConversations', JSON.stringify(saved));
      this.loadSavedConversations(); // to refresh the view
    } catch (e) {
      this.updateError('Could not delete conversation.', e as Error);
    }
  }

  render() {
    return html`
      <div>
        <h1 id="app-title">AI English Tutor</h1>
        ${this.showingSaved
          ? html`
              <div id="saved-conversations-view">
                <h2>Saved Conversations</h2>
                <div class="saved-list">
                  ${this.savedConversations.length > 0
                    ? this.savedConversations.map(
                        (conv) => html`
                          <div class="saved-entry">
                            <h3>Conversation from ${conv.date}</h3>
                            ${conv.transcript.map(
                              (entry) => html`
                                <p>
                                  <strong>${entry.speaker}:</strong>
                                  ${entry.text}
                                </p>
                              `,
                            )}
                            <button @click=${() =>
                              this.deleteConversation(conv.id)}>
                              Delete
                            </button>
                          </div>
                        `,
                      )
                    : html`<p>No saved conversations yet.</p>`}
                </div>
                <button @click=${this.toggleSavedView}>Close</button>
              </div>
            `
          : ''}

        <div id="transcript-container">
          <div id="transcript">
            ${this.transcript.map(
              (entry) => html`
                <div class="entry">
                  <strong>${entry.speaker}</strong>
                  <div>${entry.text}</div>
                </div>
              `,
            )}
            ${this.currentInputTranscription
              ? html`<div class="entry">
                  <strong>You</strong>
                  <div>${this.currentInputTranscription}</div>
                </div>`
              : ''}
            ${this.currentOutputTranscription
              ? html`<div class="entry">
                  <strong>Model</strong>
                  <div>${this.currentOutputTranscription}</div>
                </div>`
              : ''}
          </div>
        </div>

        <div id="topic-container">
          <input
            type="text"
            placeholder="Enter a topic, e.g., 'my last vacation'"
            .value=${this.topicInput}
            @input=${(e: Event) =>
              (this.topicInput = (e.target as HTMLInputElement).value)}
            ?disabled=${this.isRecording}
          />
          <button
            @click=${this.setTopic}
            ?disabled=${this.isRecording || !this.topicInput.trim()}>
            Set Topic
          </button>
        </div>

        <div class="controls">
          <button
            class="text-button"
            @click=${this.toggleSavedView}
            ?disabled=${this.isRecording}>
            View Saved
          </button>
          <button
            id="resetButton"
            @click=${this.reset}
            ?disabled=${this.isRecording}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            @click=${this.startRecording}
            ?disabled=${this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#c80000"
              xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="50" />
            </svg>
          </button>
          <button
            id="stopButton"
            @click=${this.stopRecording}
            ?disabled=${!this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#000000"
              xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="100" height="100" rx="15" />
            </svg>
          </button>
          <button
            class="text-button"
            @click=${this.saveConversation}
            ?disabled=${this.transcript.length === 0 || this.isRecording}>
            Save
          </button>
        </div>

        <div id="status">${this.error ? this.error : this.status}</div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}