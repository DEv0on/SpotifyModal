import { webpack, common, logger } from "replugged";
import * as components from "./components";
import * as icons from "./icons";

const packageName = "SpotifyModal";

const log = {
  log: (name: string, ...data: unknown): void => logger.log(name, packageName, undefined, ...data),
  warn: (name: string, ...data: unknown): void => logger.warn(name, packageName, undefined, ...data),
  error: (name: string, ...data: unknown): void => logger.error(name, packageName, undefined, ...data),
}

export async function getSpotifyAccount(accountId?: string): void | { [key: string]: unknown } {
  const store = await webpack.waitForModule(webpack.filters.byProps("getActiveSocketAndDevice"));

  if (!store) return;

  if (!accountId) {
    if (Object.keys(store.__getLocalVars().accounts).length)
      return Object.values(store.__getLocalVars().accounts)[0];
    else return;
  } else {
    if (accountId in store.__getLocalVars().accounts)
      return store.__getLocalVars().accounts[accountId];
    else return;
  }
}

export async function getSpotifySocket(accountId?: string): void | WebSocket {
  const store = await webpack.waitForModule(webpack.filters.byProps("getActiveSocketAndDevice"));

  if (!store)
    return;

  // Method I: Get from .getActiveSocketAndDevice
  let activeSocketAndDevice = store.getActiveSocketAndDevice();
  if (activeSocketAndDevice && activeSocketAndDevice.socket.accountId === accountId)
    return activeSocketAndDevice.socket.socket;

  // Method II: Get from .__getLocalVars().accounts[accountId]
  const accounts = store.__getLocalVars().accounts;
  if (accountId in accounts)
    return accounts[accountId].socket;

  // Method III: Get without accountId through both getActiveSocketAndDevice & accounts
  // (bruteforcing --- may cause inaccuracy with accountId if accountId is provided)
  activeSocketAndDevice = store.getActiveSocketAndDevice();
  if (activeSocketAndDevice)
    return activeSocketAndDevice.socket.socket;
  return Object.values(accounts).length ? Object.values(accounts)[0].socket : undefined;
}

export async function getAllSpotifySockets(): void | Record<string, WebSocket> {
  const store = await webpack.waitForModule(webpack.filters.byProps("getActiveSocketAndDevice"));

  if (!store)
    return;

  const accounts = store.__getLocalVars().accounts;
  if (!Object.keys(accounts).length)
    return;
  else {
    const sockets = {};
    Object.entries(accounts).forEach(([accountId, socket]: [string, WebSocket]): void => {
      sockets[accountId] = socket.socket;
    });
    return sockets;
  }
}

async function sendSpotifyAPI (endpoint: string, accountId?: string, method: string = "PUT", query?: Record<string, string>, body?: { [key: string]: unknown }): Promise<void | Response> {
  const account = await getSpotifyAccount(accountId);

  if (!account) return;
  let uri = `https://api.spotify.com/v1/${endpoint}`;

  if (typeof query === "object" && !Array.isArray(query)) {
    Object.entries(query).forEach(([key, value]: [string, unknown]): void => {
      uri += uri.match(/\?/) ? `&${encodeURIComponent(key)}=${encodeURIComponent(value)}` : `?${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    });
  }

  return fetch(uri, {
    mode: "cors",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account?.accessToken}`,
    },
    method,
    body,
  });
}

export const SpotifyControls = {
  sendSpotifyAPI,
  async setPlaybackState(state: boolean, accountId?: string): Promise<void | Response> {
    return sendSpotifyAPI(`me/player/${state ? "play" : "pause"}`, accountId);
  },
  async setRepeatMode(mode: string, accountId?: string): Promise<void | Response> {
    const modes = ["off", "context", "track"];
    if (modes.includes(mode))
      return;
    return sendSpotifyAPI(`me/player/repeat`, accountId, undefined, { state: mode });
  },
}

export class EventEmitter {
  public _events: Record<string, ((...args: unknown) => unknown) | Set<((...args: unknown) => unknown)>>;

  constructor() {
    this._events = {};
  }

  #fixSets(): void {
    Object.entries(this._events).forEach(([key, value]: [string, unknown]): void => {
      if (value?.constructor?.name === "Set" && value?.length === 1)
        this._events[key] = [...value.values()][0];
      if (value?.constructor?.name === "Set" && !value?.length)
        delete this._events[key];
    });
  }

  on(name: string, callback: (...args: unknown) => unknown): void {
    if (typeof name !== "string" || typeof callback !== "function")
      return;
    if (typeof this._events[name] === "function") {
      this._events[name] = new Set([this._events[name]]);
      this._events[name].add(callback);
    } else
      this._events[name] = callback;
  }

  once(name: string, callback: (...args: unknown) => unknown): void {
    if (typeof name !== "string" || typeof callback !== "function")
      return;
    const replacedFunction = (...args: unknown): void => {
      callback(...args);
      if (this._events[name]?.constructor?.name === "Set") {
        this._events[name].delete(replacedFunction);
        this.#fixSets();
      } else
        delete this._events[name];
    }
    if (typeof this._events[name] === "function") {
      this._events[name] = new Set([this._events[name]]);
      this._events[name].add(replacedFunction);
    } else
      this._events[name] = replacedFunction;
  }

  removeAllListeners(name?: string): void {
    if (typeof name === "string" && name in this._events)
      delete this._events[name];
    else this._events = {};
  }

  emit(name: string, ...data?: unknown) {
    if (name in this._events) {
      const eventListeners = this._events[name];
      if (typeof eventListeners === "function")
        eventListeners(...data);
      else {
        eventListeners.forEach((func: (...args: unknown) => unknown): void => {
          func(...data);
        });
      }
    }
  }
}

export class SpotifyWatcher extends EventEmitter {
  #accountId: string;
  public dispatcher: unknown;
  #devices: unknown;
  #modalAnimations: {
    titleElement: undefined | Animation;
    artistsElement: undefined | Animation;
  };
  #state: unknown;
  #sockets: undefined | Record<string, WebSocket>;
  #socketsPongHandlers: Record<string, ((message: unknown) => void)>;
  #socket: {
    accountId: string;
    ws: undefined | WebSocket;
  };
  public handlers: {
    REGISTER_PONG_EVENT: () => void;
    SPOTIFY_UPDATE: (data: { accountId: string }) => void;
    SPOTIFY_WEBSOCKET_MESSAGE: (message: { data: string }) => void;
  };
  #registered: boolean;
  #pongListenerRegistered: boolean;

  constructor() {
    super();
    this.#accountId = "";
    this.dispatcher = undefined;
    this.#devices = undefined;
    this.#modalAnimations = {
      titleElement: undefined,
      artistsElement: undefined,
    };
    this.#state = undefined;
    this.#sockets = undefined;
    this.#socketsPongHandlers = {};
    this.#socket = {
      accountId: "",
      ws: undefined,
    };
    this.handlers = {
      REGISTER_PONG_EVENT: (): void => {
        this.addPongEvent();
        this.dispatcher.unsubscribe("GAMES_DATABASE_UPDATE", this.handlers.REGISTER_PONG_EVENT);
      },
      SPOTIFY_UPDATE: (data: { accountId: string }): void => {
        const functionName = "SPOTIFY_UPDATE";

        if (!this.#accountId)
          this.#accountId = data.accountId;
        if (this.#accountId !== data.accountId) {
          log.error(`${this.constructor.name}@${functionName}`, "New account ID", `(${data.accountId})`, "differs from registered account ID", `(${this.#accountId}),`, "change ignored");
          return;
        }

        this.emit("update", data.accountId, this.#accountId);
        this.#afterSpotifyUpdate();
      },
      SPOTIFY_WEBSOCKET_MESSAGE: (message: { data: string }): void => {
        const data = JSON.parse(message.data);
        if (data?.type && data?.payloads && data.type !== "pong") {
          if (data.payloads[0].events[0].type === "PLAYER_STATE_CHANGED")
            this.#state = data.payloads[0].events[0].event.state;
          else if (data.payloads[0].events[0].type === "DEVICE_STATE_CHANGED")
            this.#devices = data.payloads[0].events[0].event.devices;
          this.emit("message", data.payloads[0].events[0].type, data.payloads[0].events[0].type === "PLAYER_STATE_CHANGED" ? this.#state : this.#devices);
        }
      },
    }
    this.#registered = false;
    this.#pongListenerRegistered = false;
  }

  get registered(): boolean {
    return this.#registered;
  }

  get state(): unknown {
    return this.#state ?? {};
  }

  get devices(): unknown {
    return this.#devices ?? [];
  }

  get accountId(): string {
    return this.#accountId;
  }

  set accountId(id: string) {
    if (typeof id !== "string" || this.#accountId === id)
      return;
    if (id in this.#sockets) {
      this.#accountId = id;
      this.handlers.SPOTIFY_UPDATE({ accountId: id });
    }
  }

  get socket(): { accountId: string; ws: undefined | WebSocket } {
    return {
      accountId: this.#socket.accountId,
      ws: this.#socket.ws,
    };
  }

  async #afterSpotifyUpdate(): Promise<void> {
    if (this.socket.ws && this.socket.accountId !== this.#accountId)
      this.socket.ws.removeEventListener("message", this.handlers.SPOTIFY_WEBSOCKET_MESSAGE);
    else if (this.socket.ws && this.socket.accountId === this.#accountId)
      return;

    this.socket.accountId = this.#accountId;
    this.socket.ws = await getSpotifySocket(this.#accountId);
    if (this?.socket?.ws) {
      this.socket.ws.addEventListener("message", this.handlers.SPOTIFY_WEBSOCKET_MESSAGE);
      this.emit("websocket", this.socket.ws);
    } else this.emit("error", "websocket");
  }

  removeSocketEvent(): void {
    if (!this.socket.ws)
      return;
    this.socket.ws.removeEventListener("message", this.handlers.SPOTIFY_WEBSOCKET_MESSAGE);
  }

  async addPongEvent(): void {
    this.#sockets = await getAllSpotifySockets();
    if (this.#sockets) {
      Object.entries(this.#sockets).forEach(([accountId, socket]: [string, WebSocket]): void => {
        if (this.#socketsPongHandlers[accountId] === undefined) {
          this.#socketsPongHandlers[accountId] = (message: { data: string }): void => {
            const data = JSON.parse(message.data);

            if (data?.type && data?.type === "pong")
              this.emit("pong", accountId);
          }
          socket.addEventListener("message", this.#socketsPongHandlers[accountId]);
        }
      });
    } else {
      if (!this.#pongListenerRegistered) {
        this.dispatcher.subscribe("SPOTIFY_PROFILE_UPDATE", this.handlers.REGISTER_PONG_EVENT);
        this.#pongListenerRegistered = true;
      } else
        return;
    }
  }

  removePongEvent(): void {
    if (!this.#sockets)
      return;
    Object.entries(this.#sockets).forEach(([accountId, socket]: [string, WebSocket]): void => {
      if (this.#socketsPongHandlers[accountId] !== undefined) {
        socket.removeEventListener("message", this.#socketsPongHandlers[accountId]);
        delete this.#socketsPongHandlers[accountId];
      }
    });
  }

  async registerFlux(): Promise<void> {
    const functionName = "registerFlux";
    if (common?.fluxDispatcher)
      this.dispatcher = common.fluxDispatcher;
    else
      this.dispatcher = await webpack.waitForModule(webpack.filters.byProps("_subscriptions", "subscribe", "unsubscribe"));

    if (!this.dispatcher) {
      log.error(`${this.constructor.name}@${functionName}`, "FluxDispatcher not found");
      return;
    }

    if (this.registered) {
      log.warn(`${this.constructor.name}@${functionName}`, "Already registered");
      return;
    }

    this.dispatcher.subscribe("SPOTIFY_PROFILE_UPDATE", this.handlers.SPOTIFY_UPDATE);
    this.dispatcher.subscribe("SPOTIFY_SET_DEVICES", this.handlers.SPOTIFY_UPDATE);
    this.dispatcher.subscribe("SPOTIFY_ACCOUNT_ACCESS_TOKEN", this.handlers.SPOTIFY_UPDATE);
    this.dispatcher.subscribe("SPOTIFY_SET_ACTIVE_DEVICES", this.handlers.SPOTIFY_UPDATE);
    this.dispatcher.subscribe("SPOTIFY_PLAYER_STATE", this.handlers.SPOTIFY_UPDATE);
    this.#registered = true;
    this.emit("registered");
  }

  removeFlux(): void {
    const functionName = "removeFlux";
    if (!this.dispatcher || !this.registered) {
      log.error(`${this.constructor.name}@${functionName}`, "Already removed");
      return;
    }

    this.dispatcher.unsubscribe("SPOTIFY_PROFILE_UPDATE", this.handlers.SPOTIFY_UPDATE);
    this.dispatcher.unsubscribe("SPOTIFY_SET_DEVICES", this.handlers.SPOTIFY_UPDATE);
    this.dispatcher.unsubscribe("SPOTIFY_ACCOUNT_ACCESS_TOKEN", this.handlers.SPOTIFY_UPDATE);
    this.dispatcher.unsubscribe("SPOTIFY_SET_ACTIVE_DEVICES", this.handlers.SPOTIFY_UPDATE);
    this.dispatcher.unsubscribe("SPOTIFY_PLAYER_STATE", this.handlers.SPOTIFY_UPDATE);
    this.#registered = false;
    this.emit("unregistered");
  }

  async load(): Promise<void> {
    await this.registerFlux();
    await this.addPongEvent();
    this.on("pong", (accountId: string): void => {
      this.handlers.SPOTIFY_UPDATE({ accountId });
    });
  }

  unload(): void {
    this.removeFlux();
    this.removePongEvent();
    this.removeAllListeners("pong");
    this.removeSocketEvent();
  }
}

export class SpotifyModal {
  public components: unknown;
  public icons: unknown;
  public watcher: SpotifyWatcher;
  public handlers: {
    MODAL_UPDATE: () => Promise<void>;
    PLAYER_STATE_CHANGED: () => Promise<void>;
    DEVICE_STATE_CHANGED: () => Promise<void>;
  };
  #classes: {
    activityName: string;
    anchor: string;
    anchorUnderlineOnHover: string;
    bodyLink: string;
    container: string;
    defaultColor: string;
    ellipsis: string;
    nameNormal: string;
    panels: string;
    "text-sm/semibold": string;
  };
  #status: {
    active: boolean;
    album: string;
    playing: boolean;
    progress: {
      passed: number;
      duration: number;
    },
    repeat: string;
    shuffle: boolean;
    devices: undefined | Array<{ is_active: boolean; name: string }>;
    state: unknown;
  };
  #componentsReady: boolean;
  #injected: boolean;
  #panel: undefined | Element;
  #modalAnimations: {
    titleElement: undefined | Animation;
    artistsElement: undefined | Animation;
  };
  #modalUpdateSetIntervalID: undefined | number;
  #modalUpdateRate: number;

  static parseArtists(
    track: {
      artists: Array<{ name: string; id: string }>;
      name: string;
    },
    additionalLinkElementClasses: string | undefined,
    // onRightClick: Function | undefined,
    enableTooltip?: boolean,
  ): Array<Text | HTMLAnchorElement> {
    const res: Array<Text | HTMLAnchorElement> = [];
    if (track.artists.length) {
      track.artists.forEach(({ name, id }: { name: string; id: string }, index: number) => {
        const element =
          typeof id === "string" ? document.createElement("a") : document.createTextNode("");
        if (typeof id === "string") {
          // @ts-expect-error - In this case .target does exist on element
          element.target = "_blank";
          // @ts-expect-error - In this case .href does exist on element
          element.href = `https://open.spotify.com/artist/${id}`;
          // @ts-expect-error - In this case .style does exist on element
          element.style.color = "var(--header-secondary)";
          // @ts-expect-error - In this case .classList does exist on element
          element.classList.add(
            ...(typeof additionalLinkElementClasses === "string"
              ? additionalLinkElementClasses.split(" ")
              : []),
          );
          // @ts-expect-error - In this case .title does exist on element
          if (enableTooltip) element.title = name;
          // if (typeof onRightClick === "function") element.oncontextmenu = onRightClick;
          element.appendChild(document.createTextNode(name));
        } else {
          element.nodeValue = name;
        }
        if (track.artists.length - 1 !== index) {
          res.push(element);
          res.push(document.createTextNode(", "));
        } else res.push(element);
      });
    }
    if (!res.length) res.push(document.createTextNode("Unknown"));
    return res;
  }

  static parseTime(ms: number): string {
    if (typeof ms !== "number") return "";
    const dateObject = new Date(ms);
    const raw = {
      month: dateObject.getUTCMonth(),
      day: dateObject.getUTCDate(),
      hours: dateObject.getUTCHours(),
      minutes: dateObject.getUTCMinutes(),
      seconds: dateObject.getUTCSeconds(),
    };
    const parsedHours = raw.hours + (raw.day - 1) * 24 + raw.month * 30 * 24;

    return `${parsedHours > 0 ? `${parsedHours}:` : ""}${
      raw.minutes < 10 && parsedHours > 0 ? `0${raw.minutes}` : raw.minutes
    }:${raw.seconds < 10 ? `0${raw.seconds}` : raw.seconds}`;
  }

  static getTextScrollingAnimation(element: unknown): Animation {
    const animations = element.getAnimations()
    if (animations.length)
      animations.forEach((animation: Animation): void => {
        animation.cancel();
      });
    return element.animate([
      { transform: "translateX(0)" },
      { transform: `translateX(-${element.scrollWidth - element.offsetWidth}px)` },
    ], {
      iterations: Infinity,
      duration: (element.scrollWidth - element.offsetWidth) * 50,
      direction: "alternate-reverse",
      easing: "linear",
    });
  }

  constructor(modalUpdateRate: number) {
    this.components = components;
    this.icons = icons;
    this.#classes = {};
    this.#status = {
      active: false,
      album: "",
      playing: false,
      progress: {
        passed: 0,
        duration: 0,
      },
      repeat: "off",
      shuffle: false,
      devices: undefined,
      state: undefined,
    };
    this.handlers = {
      MODAL_UPDATE: async (): Promise<void> => {
        this.icons.playPauseIcon.replaceChildren(this.#status.playing ? this.icons.playPath : this.icons.pausePath);
        this.icons.repeatIcon.replaceChildren(this.#status.repeat === "off" || this.#status.repeat === "context" ? this.icons.repeatAllPath : this.icons.repeatOnePath);
        this.icons.repeatIcon.style.color = this.#status.repeat === "off" ? "var(--text-normal)" : "var(--brand-experiment-500)";
        this.icons.shuffleIcon.style.color = this.#status.shuffle ? "var(--brand-experiment-500)" : "var(--text-normal)";

        if (!this.#status.playing || !this.#status.active) {
          if (!this.#status.active) {
            clearInterval(this.#modalUpdateSetIntervalID);
            this.#modalUpdateSetIntervalID = undefined;
            this.components.progressBarInnerElement.style.width = "0%";
            this.components.playbackTimeCurrentElement.innerText = "0:00";
            this.components.playbackTimeDurationElement.innerText = "0:00";
            if (this.components.modalElement.style.display !== "none") this.components.modalAnimations.fadeout();
            if (this.components.dockElement.style.display !== "none") this.components.dockAnimations.fadeout();
            if (this.#modalAnimations.titleElement) {
              this.#modalAnimations.titleElement.cancel();
              this.#modalAnimations.titleElement = undefined;
            }
            if (this.#modalAnimations.artistsElement) {
              this.#modalAnimations.artistsElement.cancel();
              this.#modalAnimations.artistsElement = undefined;
            }
          }
        } else {
          if (this.components.modalElement.style.display === "none") this.components.modalAnimations.fadein();
          if (this.components.dockElement.style.display === "none") this.components.dockAnimations.fadein();
          this.#status.progress.passed += this.#modalUpdateRate;
          this.components.playbackTimeCurrentElement.innerText = SpotifyModal.parseTime(this.#status.progress.passed);
          if (this.components.playbackTimeDurationElement.innerText !== SpotifyModal.parseTime(this.#status.progress.duration))
            this.components.playbackTimeDurationElement.innerText = SpotifyModal.parseTime(this.#status.progress.duration);
          this.components.progressBarInnerElement.style.width = `${((this.#status.progress.passed / this.#status.progress.duration) * 100).toFixed(4)}%`;
        }
      },
      PLAYER_STATE_CHANGED: async (data: unknown): Promise<void> => {
        this.#status.state = data;
        this.#status.playing = data.is_playing;
        this.#status.progress.passed = typeof data?.progress_ms === "number" ? data.progress_ms : 0;
        this.#status.progress.duration = typeof data?.item?.duration_ms === "number" ? data.item.duration_ms : 0;
        this.#status.repeat = data.repeat_state;
        this.#status.shuffle = data.shuffle_state;
        this.#status.album = data?.item?.album && data.item.album?.id ? `https://open.spotify.com/album/${data.item.album.id}` : "";
        this.#updateModal(data);
      },
      DEVICE_STATE_CHANGED: async (data: unknown): Promise<void> => {
        this.#status.device = data;
        if (!data.length)
          this.active = false;
        else
          this.active = true;
        this.#updateModal()
      },
    }
    this.watcher = new SpotifyWatcher;
    this.#componentsReady = false;
    this.#injected = false;
    this.#panel = undefined;
    this.#modalAnimations = {
      titleElement: undefined,
      artistsElement: undefined,
    };
    this.#modalUpdateSetIntervalID = undefined;
    this.#modalUpdateRate = typeof modalUpdateRate === "number" ? modalUpdateRate : 500;
    this.watcher.on("message", (type: string, message: unknown) => {
      if (["PLAYER_STATE_CHANGED", "DEVICE_STATE_CHANGED"].includes(type))
        this.handlers[type](message);
      else
        log.warn(`${this.constructor.name}@SpotifyWatcher @ message`, "Unknown event type recieved:", type, message);
    })
  }

  async getClasses(): Promise<void> {
    const activityClasses = await webpack.waitForModule<{
      activityName: string;
      bodyLink: string;
      ellipsis: string;
      nameNormal: string;
    }>(webpack.filters.byProps("activityName"));
    const anchorClasses = await webpack.waitForModule<{
      anchor: string;
      anchorUnderlineOnHover: string;
    }>(webpack.filters.byProps("anchorUnderlineOnHover"));
    const colorClasses = await webpack.waitForModule<{
      defaultColor: string;
      "text-sm/semibold": string;
    }>(webpack.filters.byProps("defaultColor"));
    const containerClasses = await webpack.waitForModule<{
      container: string;
    }>(webpack.filters.byProps("avatar", "customStatus"));
    const panelClasses = await webpack.waitForModule<{
      panels: string;
    }>(webpack.filters.byProps("panels"));

    this.#classes = {
      activityName: this.#classes?.activityName ?? activityClasses.activityName,
      anchor: this.#classes?.anchor ?? anchorClasses.anchor,
      anchorUnderlineOnHover:
        this.#classes?.anchorUnderlineOnHover ?? anchorClasses.anchorUnderlineOnHover,
      bodyLink: this.#classes?.bodyLink ?? activityClasses.bodyLink,
      container: this.#classes?.container ?? containerClasses.container,
      defaultColor: this.#classes?.defaultColor ?? colorClasses.defaultColor,
      ellipsis: this.#classes?.ellipsis ?? activityClasses.ellipsis,
      nameNormal: this.#classes?.nameNormal ?? activityClasses.nameNormal,
      panels: this.#classes?.panels ?? panelClasses.panels,
      "text-sm/semibold": this.#classes?.["text-sm/semibold"] ?? colorClasses["text-sm/semibold"],
    };
  }

  async getPanel(): Promise<void> {
    if (!this.classes?.panels)
      await this.getClasses();
    this.#panel = document.body.getElementsByClassName(this.classes.panels)[0];
    if (!this.#panel) {
      log.error(`${this.constructor.name}@getPanel`,"Panel not found");
      return;
    }
  }

  async initializeComponents(): Promise<void> {
    if (this.#componentsReady) {
      log.warn(`${this.constructor.name}@initializeComponents`, "Components already initialized");
      return;
    }
    if (!this.#classes?.container || !this.#classes?.anchor || !this.#classes?.defaultColor || !this.#classes?.nameNormal)
      await this.getClasses();
    if (!this.components.modalElement.className.includes(this.#classes.container))
      this.components.modalElement.classList.add(this.#classes.container);
    if (!this.components.titleElement.className.includes(this.#classes.anchor))
      this.components.titleElement.classList.add(
        this.#classes.anchor,
        this.#classes.anchorUnderlineOnHover,
        this.#classes.defaultColor,
        this.#classes["text-sm/semibold"],
        ...this.#classes.nameNormal.split(" ").filter((classes) => !classes.match(/^ellipsis/)),
      );
    this.components.coverArtElement.onclick = () => {
      if (!this.#status.album) return;
      window.open(this.#status.album, "_blank");
    };

    this.#componentsReady = true;
  }

  async injectModal(): Promise<void> {
    if (this.#injected) {
      log.warn(`${this.constructor.name}@injectModal`, "Already injected");
      return;
    }
    if (!this.#panel)
      await this.getPanel();
    if (!this.#panel) {
      log.error(`${this.constructor.name}@injectModal`, "Panel not found");
      return;
    }
    if (!this.#componentsReady)
      await this.initializeComponents();
    this.#panel.insertAdjacentElement("afterBegin", this.components.modalElement);
    this.components.modalElement.insertAdjacentElement("afterEnd", this.components.dockElement);
    this.#injected = true;
    log.log(`${this.constructor.name}@injectModal`, "Succeeded");
  }

  uninjectModal(): void {
    if (!this.#injected || !this.#panel) {
      log.warn(`${this.constructor.name}@uninjectModal`, "Already uninjected");
      return;
    }
    this.#panel.removeChild(this.components.modalElement);
    this.#panel.removeChild(this.components.dockElement);
    this.#injected = false;
    log.log(`${this.constructor.name}@uninjectModal`, "Succeeded");
  }

  async #updateModal(data?: unknown): Promise<void> {
    if (!Object.keys(this.#classes).length)
      await this.getClasses();
    if (!this.#injected)
      await this.injectModal();

    if (data) {
      if (!this.#modalUpdateRate)
        this.#modalUpdateRate = setInterval(this.handlers.MODAL_UPDATE, this.#modalUpdateRate);

      if (data?.item?.is_local) {
        this.components.titleElement.href = "";
        this.components.titleElement.style.textDecoration = "none";
        this.components.titleElement.style.cursor = "default";
        this.components.coverArtElement.src = "";
        this.components.coverArtElement.title = "";
        this.components.coverArtElement.style.cursor = "";
      } else {
        this.components.titleElement.href = `https://open.spotify.com/track/${data.item.id}`;
        this.components.titleElement.style.textDecoration = "";
        this.components.titleElement.style.cursor = "";
        this.components.coverArtElement.src = data.item.album.images[0].url;
        this.components.coverArtElement.title = data.item.album.name;
        this.components.coverArtElement.style.cursor = "pointer";
      }

      this.components.titleElement.innerText = typeof data?.item?.name === "string" ? data.item.name : "Unknown";
      this.components.titleElement.title = typeof data?.item?.name === "string" ? data.item.name : "Unknown";
      if (this.components.titleElement.scrollWidth > this.components.titleElement.offsetWidth + 20) {
        if (this.components.titleElement.className.includes(this.#classes.ellipsis))
          this.components.titleElement.classList.remove(this.#classes.ellipsis);
        this.#modalAnimations.titleElement = SpotifyModal.getTextScrollingAnimation(this.components.titleElement);
      } else {
        if (this.#modalAnimations.titleElement) {
          this.#modalAnimations.titleElement.cancel();
          this.#modalAnimations.titleElement = undefined;
        }
        if (!this.components.titleElement.className.includes(this.#classes.ellipsis))
          this.components.titleElement.classList.add(this.#classes.ellipsis);
      }

      this.components.artistsElement.replaceChildren(...SpotifyModal.parseArtists(
        data.item,
        `${this.#classes.anchor} ` +
          `${this.#classes.anchorUnderlineOnHover} ` +
          `${this.#classes.bodyLink} ` +
          `${this.#classes.ellipsis}`,
      ));
      if (this.components.artistsElement.scrollWidth > this.components.artistsElement.offsetWidth + 20) {
        if (this.components.artistsElement.className.includes(this.#classes.ellipsis))
          this.components.artistsElement.classList.remove(this.#classes.ellipsis);
        this.#modalAnimations.artistsElement = SpotifyModal.getTextScrollingAnimation(this.components.artistsElement);
      } else {
        if (this.#modalAnimations.artistsElement) {
          this.#modalAnimations.artistsElement.cancel();
          this.#modalAnimations.artistsElement = undefined;
        }
        if (!this.components.artistsElement.className.includes(this.#classes.ellipsis))
          this.components.artistsElement.classList.add(this.#classes.ellipsis);
      }
    }
  }

  async load() {
    await this.watcher.load();
    await this.getClasses();
    await this.injectModal();
  }
}