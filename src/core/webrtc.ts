import { joinRoom, selfId, type Room } from "@trystero-p2p/mqtt";

export type ControllerKeyEvent = {
  key: string;
  action: "down" | "up";
  timestamp: number;
  [key: string]: string | number;
};

export type ControllerCommand =
  | "start"
  | "level-select"
  | "pause"
  | "restart"
  | "play"
  | "edit"
  | "back"
  | "quit"
  | "up"
  | "down"
  | "ok";

export type ControllerCommandEvent = {
  command: ControllerCommand;
  id: string;
  timestamp: number;
  [key: string]: string | number;
};

export type ControllerState = {
  screen: "home" | "song-select" | "level-select" | "edit" | "playing";
  songSelectMode: "play" | "manage";
  isPaused: boolean;
  isGameFinished: boolean;
};

export type ClockPingEvent = { t: number };
export type ClockPongEvent = { pingT: number; phoneT: number };

export interface WebRtcControllerCallbacks {
  onPeerJoin?: (peerId: string) => void;
  onPeerLeave?: (peerId: string) => void;
  onKeyMessage?: (event: ControllerKeyEvent, peerId: string) => void;
  onCommandMessage?: (event: ControllerCommandEvent, peerId: string) => void;
  onStateMessage?: (state: ControllerState, peerId: string) => void;
}

const APP_ID = "piecemusic-rhythm-game";
const RELAY_URLS = [
  "wss://public:public@public.cloud.shiftr.io",
  "wss://test.mosquitto.org:8081/mqtt",
];

/**
 * Generate a short, readable 6-character room ID
 */
export function generateRoomId(): string {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let result = "PM-";
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export class WebRtcHost {
  private room: Room | null = null;
  private keyAction: any = null;
  private commandAction: any = null;
  private stateAction: any = null;
  private pingAction: any = null;
  private pongAction: any = null;
  private clockOffsetMs = 0;
  private clockOffsetSamples = 0;
  private syncTimer: number | null = null;
  public readonly selfPeerId = selfId;

  constructor(
    public readonly roomId: string,
    private callbacks: WebRtcControllerCallbacks = {},
  ) {}

  public start(): void {
    if (this.room) return;

    // Connect via reliable public MQTT signaling beacons
    this.room = joinRoom(
      {
        appId: APP_ID,
        relayConfig: {
          urls: RELAY_URLS,
          warnOnRelayFailure: false,
        },
      },
      this.roomId,
    );

    this.keyAction = this.room.makeAction<ControllerKeyEvent>("key");

    this.keyAction.onMessage = (
      data: ControllerKeyEvent,
      context: { peerId: string },
    ) => {
      this.callbacks.onKeyMessage?.(data, context.peerId);
    };

    this.commandAction =
      this.room.makeAction<ControllerCommandEvent>("command");

    this.commandAction.onMessage = (
      data: ControllerCommandEvent,
      context: { peerId: string },
    ) => {
      this.callbacks.onCommandMessage?.(data, context.peerId);
    };

    this.stateAction = this.room.makeAction<ControllerState>("state");

    // Clock synchronization: periodically ping the controller so the host can
    // estimate the offset between the phone's performance.now() clock and its
    // own. Used to judge note hits at press-time rather than packet-arrival time.
    this.pingAction = this.room.makeAction<ClockPingEvent>("ping");
    this.pongAction = this.room.makeAction<ClockPongEvent>("pong");
    this.pongAction.onMessage = (data: ClockPongEvent) => {
      const now = performance.now();
      const rtt = now - data.pingT;
      if (rtt < 0 || rtt > 2000) return; // ignore stale/malformed pongs
      const sample = data.phoneT - (data.pingT + rtt / 2); // phoneClock - hostClock
      if (this.clockOffsetSamples === 0) {
        this.clockOffsetMs = sample;
      } else {
        this.clockOffsetMs = this.clockOffsetMs * 0.7 + sample * 0.3;
      }
      this.clockOffsetSamples++;
    };
    this.startClockSync();

    this.room.onPeerJoin = (peerId: string) => {
      this.callbacks.onPeerJoin?.(peerId);
    };

    this.room.onPeerLeave = (peerId: string) => {
      this.callbacks.onPeerLeave?.(peerId);
    };
  }

  public getConnectedPeerCount(): number {
    if (!this.room) return 0;
    const peers = this.room.getPeers();
    return Object.keys(peers).length;
  }

  private startClockSync(): void {
    if (this.syncTimer !== null) return;
    this.syncTimer = window.setInterval(() => {
      if (this.pingAction && this.getConnectedPeerCount() > 0) {
        this.pingAction.send({ t: performance.now() }).catch(() => {});
      }
    }, 1500);
  }

  /**
   * Estimated offset (ms) to subtract from a phone performance.now() timestamp
   * to convert it into host-clock time: hostClock = phoneClock - offset.
   */
  public getClockOffsetMs(): number {
    return this.clockOffsetMs;
  }

  public sendState(state: ControllerState): void {
    if (!this.stateAction) return;
    this.stateAction.send(state).catch((err: unknown) => {
      console.warn("Failed to send state over WebRTC:", err);
    });
  }

  public stop(): void {
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.clockOffsetMs = 0;
    this.clockOffsetSamples = 0;

    if (this.room) {
      try {
        this.room.leave();
      } catch (err) {
        console.warn("Error leaving WebRTC room:", err);
      }
      this.room = null;
      this.keyAction = null;
      this.commandAction = null;
      this.stateAction = null;
      this.pingAction = null;
      this.pongAction = null;
    }
  }
}

export class WebRtcClient {
  private room: Room | null = null;
  private keyAction: any = null;
  private commandAction: any = null;
  private stateAction: any = null;
  private pingAction: any = null;
  private pongAction: any = null;
  public readonly selfPeerId = selfId;

  constructor(
    public readonly roomId: string,
    private callbacks: WebRtcControllerCallbacks = {},
  ) {}

  public start(): void {
    if (this.room) return;

    this.room = joinRoom(
      {
        appId: APP_ID,
        relayConfig: {
          urls: RELAY_URLS,
          warnOnRelayFailure: false,
        },
      },
      this.roomId,
    );
    this.keyAction = this.room.makeAction<ControllerKeyEvent>("key");
    this.stateAction = this.room.makeAction<ControllerState>("state");

    this.stateAction.onMessage = (
      data: ControllerState,
      context: { peerId: string },
    ) => {
      this.callbacks.onStateMessage?.(data, context.peerId);
    };
    this.commandAction =
      this.room.makeAction<ControllerCommandEvent>("command");

    // Clock sync: answer host pings so it can measure the phone↔host clock offset.
    this.pingAction = this.room.makeAction<ClockPingEvent>("ping");
    this.pongAction = this.room.makeAction<ClockPongEvent>("pong");
    this.pingAction.onMessage = (data: ClockPingEvent) => {
      this.pongAction
        ?.send({ pingT: data.t, phoneT: performance.now() })
        .catch(() => {});
    };

    this.room.onPeerJoin = (peerId: string) => {
      this.callbacks.onPeerJoin?.(peerId);
    };

    this.room.onPeerLeave = (peerId: string) => {
      this.callbacks.onPeerLeave?.(peerId);
    };
  }

  public sendKey(key: string, action: "down" | "up"): void {
    if (!this.keyAction) return;
    const payload: ControllerKeyEvent = {
      key,
      action,
      timestamp: performance.now(),
    };
    this.keyAction.send(payload).catch((err: unknown) => {
      console.warn("Failed to send key action over WebRTC:", err);
    });

    // The data channel is unordered + unreliable (maxRetransmits: 0). Duplicate
    // "down" events carry the same timestamp, so they are idempotent on the host
    // (press-time judgment + already-hit dedup): a single dropped packet can no
    // longer eat a note hit.
    if (action === "down") {
      const sendCopy = () => {
        this.keyAction?.send(payload).catch(() => {});
      };
      setTimeout(sendCopy, 4);
      setTimeout(sendCopy, 8);
    }
  }

  public sendCommand(command: ControllerCommand, id = ""): void {
    if (!this.commandAction) return;
    const payload: ControllerCommandEvent = {
      command,
      id,
      timestamp: performance.now(),
    };
    this.commandAction.send(payload).catch((err: unknown) => {
      console.warn("Failed to send command over WebRTC:", err);
    });
  }

  public stop(): void {
    if (this.room) {
      try {
        this.room.leave();
      } catch (err) {
        console.warn("Error leaving WebRTC room:", err);
      }
      this.room = null;
      this.keyAction = null;
      this.commandAction = null;
      this.stateAction = null;
      this.pingAction = null;
      this.pongAction = null;
    }
  }
}
