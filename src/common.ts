/* eslint-disable
  @typescript-eslint/naming-convention,
  @typescript-eslint/no-inferrable-types,
  @typescript-eslint/no-floating-promises,
  @typescript-eslint/require-await
*/
import { Logger, webpack } from 'replugged';
import { CSSStyleProperties, SpotifySocket, SpotifySocketModule } from './types';

export class EventEmitter {
  public readonly name = this.constructor.name;
  public addEventListener = this.on;

  private _events: Map<string, Set<(...args: unknown[]) => void>> = new Map();
  // @ts-expect-error - I want my own logger type thank you very much
  public _logger = new Logger('SpotifyModal', this.name);

  private _createOnceCallback(
    name: string,
    callback: (...args: unknown[]) => void,
  ): void | ((...args: unknown[]) => void) {
    if (typeof name === 'string' && typeof callback === 'function') {
      const func = (...args: unknown[]): void => {
        callback(...args);
        this._events.get(name).delete(func);
      };

      return func;
    }
  }

  public get events(): Map<string, Set<(...args: unknown[]) => void>> {
    return this._events;
  }

  public async emit(name: string, ...args: unknown[]): Promise<void> {
    if (this._events.has(name)) {
      const listeners = this._events.get(name);
      for (const listener of listeners) listener(...args);
    } else this._logger.log('[@emit]', 'No matching listeners for event', name);
  }

  public on(name: string, callback: (...args: unknown[]) => void): void {
    if (typeof name === 'string' && typeof callback === 'function') {
      if (!this._events.has(name)) this._events.set(name, new Set());
      this._events.get(name).add(callback);
    } else this._logger.log('[@on]', 'Name / callback is of invalid type');
  }

  public once(name: string, callback: (...args: unknown[]) => void): void {
    if (typeof name === 'string' && typeof callback === 'function') {
      const callbackFn: (...args: unknown[]) => void = this._createOnceCallback(name, callback) as (
        ...args: unknown[]
      ) => void;
      this.on(name, callbackFn);
    } else this._logger.log('[@once]', 'Name / callback is of invalid type');
  }

  public removeAllListeners(name?: string): boolean {
    if (this._events.has(name)) return this._events.delete(name);
    else if (!name) {
      this._events.clear();
      return true;
    } else return false;
  }
}

export class SpotifyAPI {
  public readonly name = this.constructor.name;

  private _account: SpotifySocket;
  private _ready: boolean = false;
  // @ts-expect-error - I want my own logger type thank you very much
  private _logger = new Logger('SpotifyModal', this.name);

  public constructor(account: SpotifySocket) {
    if (typeof account?.accountId !== 'string' || typeof account?.accessToken !== 'string')
      this._logger.error('[@constructor]', 'Invalid account');

    this._account = account;
    this._ready =
      typeof this._account?.accountId === 'string' &&
      typeof this._account?.accessToken === 'string';
  }

  public get accountId(): string {
    return this._account.accountId;
  }

  public get accessToken(): string {
    return this._account.accessToken;
  }

  public get ready(): boolean {
    return this._ready;
  }

  public async sendGenericRequest(
    endpoint: string,
    method = 'GET',
    query?: Record<string, string | number | boolean>,
    body?: BodyInit,
  ): Promise<void | Response> {
    if (!this._ready) {
      this._logger.error('[@sendGenericRequest]', 'API not ready');
      return;
    }
    if (typeof endpoint !== 'string' || !endpoint) {
      this._logger.error(`[${this.accountId}]`, 'Invalid endpoint');
      return;
    }

    let parsedEndpoint = endpoint.replace('/$', '');
    if (!parsedEndpoint.match('^/')) parsedEndpoint = `/${parsedEndpoint}`;
    if (typeof query === 'object' && !Array.isArray(query))
      for (const [key, value] of Object.entries(query))
        parsedEndpoint += `${parsedEndpoint.match(/\?/) ? '&' : '?'}${encodeURIComponent(
          key,
        )}=${encodeURIComponent(value)}`;

    return fetch(`https://api.spotify.com/v1${parsedEndpoint}`, {
      mode: 'cors',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      method,
      body,
    });
  }

  public getPlayerState(): Promise<void | Response> {
    return this.sendGenericRequest('/me/player');
  }

  public getDevices(): Promise<void | Response> {
    return this.sendGenericRequest('/me/player/devices');
  }

  public setPlaybackState(state: boolean): Promise<void | Response> {
    return this.sendGenericRequest(`/me/player/${state ? 'play' : 'pause'}`, 'PUT');
  }

  public async setRepeatState(state: 'off' | 'context' | 'track'): Promise<void | Response> {
    if (!['off', 'context', 'track'].includes(state)) return;
    return this.sendGenericRequest('/me/player/repeat', 'PUT', { state });
  }

  public setShuffleState(state: boolean): Promise<void | Response> {
    return this.sendGenericRequest('/me/player/shuffle', 'PUT', { state });
  }

  public async seekToPos(position_ms: number): Promise<void | Response> {
    if (typeof position_ms === 'number')
      return this.sendGenericRequest('/me/player/seek', 'PUT', { position_ms });
  }

  public async setPlaybackVolume(volume_percent: number): Promise<void | Response> {
    if (typeof volume_percent === 'number' && volume_percent >= 0 && volume_percent <= 100)
      return this.sendGenericRequest('/me/player/volume', 'PUT', { volume_percent });
  }

  public skipNext(): Promise<void | Response> {
    return this.sendGenericRequest('/me/player/next', 'POST');
  }

  public skipPrevious(): Promise<void | Response> {
    return this.sendGenericRequest('/me/player/previous', 'POST');
  }
}

export class SpotifySocketFunctions extends EventEmitter {
  public readonly name = this.constructor.name;

  private _account: undefined | SpotifySocket = undefined;
  private _accountList: Record<string, SpotifySocket> = {};
  private _ready = false;
  private _store: undefined | SpotifySocketModule = undefined;
  private _websocket: undefined | WebSocket = undefined;
  private _websocketList: Record<string, WebSocket> = {};

  public constructor() {
    super();
    this.getStore();
  }

  public get userHasSpotifyAccounts(): boolean {
    if (this._accountList && Object.keys(this._accountList).length) return true;
    else return false;
  }

  public get account(): void | SpotifySocket {
    return this._account;
  }

  public get accountList(): Record<string, SpotifySocket> {
    return this._accountList;
  }

  public get ready(): boolean {
    return this._ready;
  }

  public get store(): void | SpotifySocketModule {
    return this._store;
  }

  public get websocket(): void | WebSocket {
    return this._websocket;
  }

  public get websocketList(): Record<string, WebSocket> {
    return this._websocketList;
  }

  public async getStore(): Promise<void> {
    this._store = (await webpack.waitForModule(
      webpack.filters.byProps('getActiveSocketAndDevice'),
    )) as unknown as SpotifySocketModule;
    this.emit('ready');
    this._ready = true;
  }

  public async getAccounts(): Promise<void | Record<string, SpotifySocket>> {
    if (!this._ready) this.once('ready', () => this.getAccounts());
    else {
      this._accountList = this._store.__getLocalVars().accounts;
      return this._accountList;
    }
  }

  public async getAccount(accountId?: string): Promise<void | SpotifySocket> {
    if (!this._ready) this.once('ready', () => this.getAccount(accountId));
    else {
      this._accountList = this._store.__getLocalVars().accounts;
      let account: undefined | SpotifySocket;
      const activeSocketAndDevice = this._store.getActiveSocketAndDevice();

      if (!accountId && activeSocketAndDevice) {
        this._account = activeSocketAndDevice.socket;
        return activeSocketAndDevice.socket;
      }

      if (!Object.keys(this._accountList).length) return;
      else if (accountId in this._accountList) account = this._accountList[accountId];
      else if (!accountId) account = Object.values(this._accountList)[0];

      return (this._account = account);
    }
  }

  public async getWebSocket(accountId?: string): Promise<void | WebSocket> {
    if (!this._ready) this.once('ready', () => this.getWebSocket(accountId));
    else if (this._account && !accountId) return this._account.socket;
    else {
      const activeSocketAndDevice = this._store.getActiveSocketAndDevice();
      if (!accountId && activeSocketAndDevice) {
        this._websocket = activeSocketAndDevice.socket.socket;
        return activeSocketAndDevice.socket.socket;
      }

      this._accountList = this._store.__getLocalVars().accounts;

      if (Object.keys(this._accountList).length)
        for (const [id, socket] of Object.entries(this._accountList))
          this._websocketList[id] = socket.socket;
      else return;

      if (accountId in this._websocketList) return this._websocketList[accountId];
    }
  }

  public async getAllWebSockets(): Promise<void | Record<string, WebSocket>> {
    if (!this._ready) this.once('ready', () => this.getAllWebSockets());
    else {
      this._accountList = this._store.__getLocalVars().accounts;

      if (Object.keys(this._accountList).length)
        for (const [accountId, socket] of Object.entries(this._accountList))
          this._websocketList[accountId] = socket.socket;
      else return;

      return this._websocketList;
    }
  }

  public async getAPI(accountId?: string): Promise<void | SpotifyAPI> {
    if (!this._ready) return;

    const account = await this.getAccount(accountId);

    if (account) return new SpotifyAPI(account);
    if (this._account) return new SpotifyAPI(this._account);
  }
}

/** Get all property descriptors of an object, including those on the prototype chain */
export function getAllPropDescriptors(object: unknown): void | Record<string, PropertyDescriptor> {
  if ([undefined, null].includes(object)) return;

  let descriptors: Record<string, PropertyDescriptor> = {};
  let currentPrototype: unknown;
  let end = false;

  while (!end) {
    currentPrototype = currentPrototype
      ? Object.getPrototypeOf(currentPrototype)
      : Object.getPrototypeOf(object);
    descriptors = { ...descriptors, ...Object.getOwnPropertyDescriptors(currentPrototype) };
    if (Object.getPrototypeOf(currentPrototype) === null) end = true;
  }

  return descriptors;
}

export function getAllSetters(object: unknown): void | string[] {
  const descriptors = getAllPropDescriptors(object);
  const setterNames: string[] = [];

  if (!descriptors || !Object.keys(descriptors).length) return;
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (typeof descriptor?.set === 'function') setterNames.push(name);
  }

  return setterNames;
}

export class Component {
  public static createElement(svg: boolean, tag: string): void | HTMLElement | SVGElement {
    if (typeof tag !== 'string') return;

    let element: HTMLElement | SVGElement;

    if (svg) element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    else element = document.createElement(tag);

    return element;
  }

  public static constructFromElement(element: HTMLElement | SVGElement): void | Component {
    if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return;
    const instance = new Component('div');
    this.#replaceElement(instance, element);

    return instance;
  }

  /**
   * This method gaslights a provided Component instance to make it believe our newly provided element is its own element all along
   * @param {Component}               instance
   * @param {HTMLElement|SVGElement}  element
   */
  static #replaceElement(instance: Component, element: HTMLElement | SVGElement): void {
    if (
      (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) ||
      !(instance instanceof Component)
    )
      return;
    instance.#svg = element instanceof SVGElement;
    instance.#element = element;
    instance.animations = element.getAnimations();
    instance.parents = new Set<Component | HTMLElement | SVGElement>();
    instance.children = new Set<Component | HTMLElement | SVGElement>([
      element as Component | HTMLElement | SVGElement,
    ]);
  }

  public static svgTags = [
    /^altGlyph(|Def|Item)$/,
    /^animate(|Motion|Transform)$/,
    /^(circle|ellipse|line|poly(gon|line)|rect)$/,
    /^(clipPath|(|m)path)$/,
    /^de(fs|sc)$/,
    /^(set|stop)$/,
    'color-profile',
    'cursor',
    /^fe[A-Z].*$/,
    'filter',
    /^font(|-face(|-format|-name|-src|-uri))$/,
    'foreignObject',
    'g',
    /^glyph(|Ref)$/,
    /^(h|v)kern$/,
    /^(linear|radial)Gradient$/,
    'marker',
    'mask',
    'metadata',
    'missing-glyph',
    'svg',
    'switch',
    'symbol',
    /^text(|Path)$/,
    'title',
    /^t(ref|span)$/,
    'use',
    'view',
  ];

  public on = this.addEventListener;
  public animations: Animation[] = [];
  public children = new Set<Component | Node>();
  #element: HTMLElement | SVGElement;
  public parents = new Set<Component | HTMLElement | SVGElement>();
  #svg: boolean;

  public _setAttribute(name: string, value: string): void {
    if (typeof value !== 'string') return;
    if (this.isSVG) this.#element.setAttributeNS(undefined, name, value);
    else this.#element.setAttribute(name, value);
  }

  public constructor(
    tag: string,
    options?: {
      children?: Array<Component | Node>;
      classes?: string;
      props?: Record<string, string>;
      style?: CSSStyleProperties;
      svg?: boolean;
    },
  ) {
    Object.defineProperty(this, 'on', {
      configurable: true,
      value: this.addEventListener,
    });

    if (typeof tag !== 'string') return;

    this.#svg = Component.svgTags.some((match) => {
      if (match instanceof RegExp) return match.test(tag);
      else return match === tag;
    });

    if (typeof options?.svg === 'boolean') this.#svg = options.svg;

    this.#element = Component.createElement(this.#svg, tag) as HTMLElement | SVGElement;

    if (typeof options === 'object' && !Array.isArray(options)) {
      if (Array.isArray(options?.children)) this.addChildren(...options.children);
      if (typeof options?.classes === 'string') this.addClasses(options.classes);
      if (typeof options?.props === 'object' && !Array.isArray(options?.props))
        this.setProps(options.props);
      if (typeof options?.style === 'object' && !Array.isArray(options?.style))
        this.setStyle(options.style);
    }
  }

  public get isSVG(): boolean {
    return this.#svg;
  }

  public get element(): HTMLElement | SVGElement {
    return this.#element;
  }

  public get classes(): DOMTokenList {
    return this.#element.classList;
  }

  public addEventListener(name: string, callback: (...args: unknown[]) => void): void {
    if (typeof name !== 'string' || typeof callback !== 'function') return;
    this.#element.addEventListener(name, callback);
  }

  public once(name: string, callback: (...args: unknown[]) => void): void {
    if (typeof name !== 'string' || typeof callback !== 'function') return;
    const replacedCallback = (...args: unknown[]): void => {
      callback(...args);
      this.removeEventListener(name, replacedCallback);
    };
    this.addEventListener(name, replacedCallback);
  }

  public removeEventListener(name: string, callback: (...args: unknown[]) => void): void {
    if (typeof name !== 'string' || typeof callback !== 'function') return;
    this.#element.removeEventListener(name, callback);
  }

  public addChildren(...children: Array<Component | Node>): void {
    for (const child of children) {
      if (this.children.has(child)) continue;
      if (child instanceof Component) {
        this.#element.appendChild(child.element);
        child.parents.add(this);
      } else if (child instanceof Node) this.#element.appendChild(child);
      else continue;

      this.children.add(child);
    }
  }

  public addClasses(...classes: string[]): void {
    const classesList = classes
      .filter((className): boolean => typeof className === 'string')
      .filter((className): boolean => Boolean(className))
      .map((className): string[] => className.split(' '))
      .flat();
    if (!classesList.length) return;
    this.#element.classList.add(...classesList);
  }

  public removeClasses(...classes: string[]): void {
    const classesList = classes
      .filter((className): boolean => typeof className === 'string')
      .filter((className): boolean => Boolean(className))
      .map((className): string[] => className.split(' '))
      .flat();
    if (!classesList.length) return;
    this.#element.classList.remove(...classesList);
  }

  public addParents(...parents: Array<Component | HTMLElement | SVGElement>): void {
    for (const parent of parents) {
      if (this.parents.has(parent)) continue;
      if (parent instanceof Component) parent.addChildren(this);
      else if (parent instanceof HTMLElement || parent instanceof SVGElement)
        parent.appendChild(this.#element);
      else continue;

      this.parents.add(parent);
    }
  }

  public removeParents(...parents: Array<Component | HTMLElement | SVGElement>): void {
    for (const parent of parents) {
      if (parent instanceof Component) parent.removeChildren(this);
      else if (parent instanceof HTMLElement || parent instanceof SVGElement)
        parent.removeChild(this.#element);
      else continue;

      this.parents.delete(parent);
    }
  }

  public removeChildren(...children: Array<Component | Node>): void {
    for (const child of children) {
      if (child instanceof Component) {
        this.#element.removeChild(child.element);
        child.parents.delete(this);
      } else if (child instanceof Node) this.#element.removeChild(child);
      else continue;

      this.children.delete(child);
    }
  }

  public replaceChildren(...children: Array<Component | Node>): void {
    this.removeChildren(...[...this.children.values()]);
    this.addChildren(...children);
  }

  // Inappropriate joke not intended for the next two methods starting from this line
  public insertChildren(position: InsertPosition, child: Component | Element): void {
    if (
      !['beforebegin', 'afterbegin', 'beforeend', 'afterend'].includes(position) ||
      (!(child instanceof Component) && !(child instanceof Node))
    )
      return;
    this.#element.insertAdjacentElement(
      position,
      child instanceof Component ? child.element : child,
    );
    if (child instanceof Component) child.parents.add(this);
    this.children.add(child);
  }

  public insertIntoParent(
    position: InsertPosition,
    parent: Component | HTMLElement | SVGElement,
  ): void {
    if (
      !['beforebegin', 'afterbegin', 'beforeend', 'afterend'].includes(position) ||
      (!(parent instanceof Component) &&
        !(parent instanceof HTMLElement) &&
        !(parent instanceof SVGElement))
    )
      return;
    if (parent instanceof Component) parent.insertChildren(position, this);
    else {
      parent.insertAdjacentElement(position, this.element);
      this.parents.add(parent);
    }
  }

  public getProps(...propNames: string[]): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    for (const propName of propNames.filter((name): boolean => typeof name === 'string')) {
      props[propName] = this.#element?.[propName] || this.#element.getAttribute(propName);
    }

    return props;
  }

  public setProps(props: Record<string, string>): void {
    const setters = getAllSetters(this.element) as string[];
    for (const [name, value] of Object.entries(props).filter(
      ([name]): boolean => typeof name === 'string',
    )) {
      if (name === 'style') this.setStyle(value);
      else if (setters.includes(name)) this.#element[name] = value;
      else this._setAttribute(name, value);
    }
  }

  public setStyle(styles: string | CSSStyleProperties): void {
    if (!['object', 'string'].includes(typeof styles) || Array.isArray(styles)) return;

    if (typeof styles === 'string') this._setAttribute('style', styles);
    else {
      for (const [key, value] of Object.entries(styles).filter(
        ([_key, value]: [string, string]): boolean => typeof value === 'string',
      )) {
        if (key in this.#element.style) this.#element.style[key] = value;
      }
    }
  }

  public addAnimation(
    keyframes: Keyframe[] | PropertyIndexedKeyframes,
    options?: number | KeyframeAnimationOptions,
  ): void | Animation {
    if (typeof keyframes !== 'object') return;
    const animation = new Animation(new KeyframeEffect(this.#element, keyframes, options));

    this.animations.push(animation);
    return animation;
  }

  public playAnimation(
    keyframes: Keyframe[] | PropertyIndexedKeyframes,
    options?: number | KeyframeAnimationOptions,
  ): void | Animation {
    const animation = this.addAnimation(keyframes, options);

    if (!animation) return;
    animation.play();
    return animation;
  }
}

/*
export class Component {
  #animations: Record<string, Animation> = {};
  #element: HTMLElement | SVGElement;
  #listeners: Record<string, Set<(...args: unknown) => void>> = {};
  #parent: undefined | Component = undefined;
  #svg: boolean;

  public constructor(
    tag: string,
    options?: {
      svg?: boolean;
      classes?: string[];
      children?: Array<HTMLElement | SVGElement>;
      props?: { [key: string]: unknown };
    },
  ) {
    if (typeof tag !== 'string') return;
    this.#svg = Boolean(options?.svg);
    this.#element = (
      this.#svg
        ? (t: string): SVGElement => document.createElementNS('http://www.w3.org/2000/svg', t)
        : (t: string): HTMLElement => document.createElement(t)
    )(tag);
    if (typeof options === 'object' && !Array.isArray(options)) {
      if (typeof options?.props === 'object' && !Array.isArray(options?.props))
        this.setProps(options.props);
      if (Array.isArray(options?.classes)) this.setClasses(...options.classes);
      if (Array.isArray(options?.children)) this.addChildren(...options.children);
    }
  }

  #fixListenerList(): void {
    Object.entries(this.#listeners).forEach(([name, set]): void => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      if (!set.size) delete this.#listeners[name];
    });
  }

  public get animations(): Record<string, Animation> {
    return this.#animations;
  }

  public get classes(): string {
    return this.#element.className;
  }

  public get element(): HTMLElement | SVGElement {
    return this.#element;
  }
  
  public set parent(parent: Component) {
    if (!parent && this.#parent instanceof Component) {
      this.#parent.removeChildren(this.#element);
      this.#parent = undefined;
    } else if (parent instanceof Component) {
      if (this.#parent instanceof Component)
        this.#parent.removeChildren(this.#element);
      this.#parent = parent;
      this.#parent.addChildren(this.#element);
    }
  }
  
  public get parent(): undefined | Component {
    return this.#parent;
  }

  public addChildren(...children: Array<Component | HTMLElement | SVGElement>): Component {
    for (const child of children) {
      if (
        !(child instanceof HTMLElement) &&
        !(child instanceof SVGElement) &&
        !(child instanceof Component)
      )
        continue;
      if (child === this.element || child?.element === this.element) continue;
      if (child instanceof Component) child.parent = this;
      else this.#element.appendChild(child);
    }

    return this;
  }

  public removeChildren(...children: Array<HTMLElement | SVGElement>): Component {
    for (const child of children) {
      if (!(child instanceof HTMLElement) && !(child instanceof SVGElement)) continue;
      if (child === this.element) continue;
      this.#element.removeChild(child);
    }

    return this;
  }

  public setProps(props: { [key: string]: unknown }): Component {
    if (typeof props !== 'object' || Array.isArray(props)) return;
    for (const [key, value] of Object.entries(props))
      (this.#svg
        ? (k: string, v: unknown): unknown => this.#element.setAttributeNS(undefined, k, v)
        : (k: string, v: unknown): unknown => this.#element.setAttribute(k, v))(key, value);
    return this;
  }

  public setStyle(style: string | CSSStyleProperties): Component {
    if (typeof style === 'string') this.setProps({ style });
    else if (typeof style === 'object')
      Object.entries(style).forEach(([key, value]: [string, string]): void => {
        if (Object.keys(this.#element.style).includes(key)) this.#element.style[key] = value;
      });

    return this;
  }

  public setListener(type: string, callback: (...args: unknown) => void): Component {
    if (typeof type !== 'string' || typeof callback !== 'function') return this;
    if (!this.#listeners?.[type.toLowerCase()])
      this.#listeners[type.toLowerCase()] = new Set<(...args: unknown) => void>();

    if (!this.#listeners?.[type.toLowerCase()].has(callback)) {
      this.#element.addEventListener(type.toLowerCase(), callback);
      this.#listeners[type.toLowerCase()].add(callback);
    }

    return this;
  }

  public removeListener(type: string, callback: (...args: unknown) => void): Component {
    if (
      typeof type !== 'string' ||
      typeof callback !== 'function' ||
      !this.#listeners?.[type.toLowerCase()]
    )
      return this;

    if (this.#listeners[type.toLowerCase()].has(callback)) {
      this.#element.removeEventListener(type.toLowerCase(), callback);
      this.#listeners[type.toLowerCase()].delete(callback);
      this.#fixListenerList();
    }

    return this;
  }

  public setClasses(...classes: string[]): Component {
    this.#element.classList.add(
      ...classes
        .filter((className): boolean => typeof className === 'string')
        .map((className): string[] => className.split(' '))
        .flat(),
    );

    return this;
  }

  public removeClasses(...classes: string[]): Component {
    this.#element.classList.remove(
      ...classes
        .filter((className): boolean => typeof className === 'string')
        .map((className): string[] => className.split(' '))
        .flat(),
    );

    return this;
  }

  public setAnimation(
    name: string,
    keyframes: Keyframes[] | PropertyIndexedKeyframes,
    options?: number | KeyframeAnimationOptions,
  ): void | Animation {
    if (typeof name !== 'string' || typeof keyframes !== 'object') return;
    return (this.#animations[name] = new Animation(
      new KeyframeEffect(this.#element, keyframes, options),
    ));
  }

  public playAnimationInstantly(
    name: string,
    keyframes: Keyframes[] | PropertyIndexedKeyframes,
    options?: number | KeyframeAnimationOptions,
  ): void | Animation {
    if (typeof keyframes !== 'object') return;

    if (typeof name === 'string')
      return (this.#animations[name] = this.#element.animate(keyframes, options));
    return this.#element.animate(keyframes, options);
  }

  public removeAnimation(name?: string): boolean {
    if (
      typeof name === 'string' &&
      Object.keys(this.#animations).includes(name) &&
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      !this.#animations[name].finished
    ) {
      this.#animations[name].cancel();
      return true;
    } else return false;

    if (Object.keys(this.#animation).length) {
      for (const animation of Object.value(this.#animations)) {
        animation.cancel();
      }
      return true;
    }

    return false;
  }
} */

/*
export const elementUtilities = {
  attributes: {
    svg: { viewBox: "0 0 24 24" },
    path: { fill: "currentColor" },
  },
  effects(
    tag: "fade" | "hover" | "scrolling",
    element: HTMLElement | SVGElement,
    props?: {
      hover?: {
        duration?: number;
        onhover: ((mouseEvent: MouseEvent) => void) | string;
        onleave: ((mouseEvent: MouseEvent) => void) | string;
      };
      scrolling?: {
        instant: boolean;
      };
    },
  ): void | FadeAnimations | Animation {
    if (
      !["fade", "hover", "scrolling"].includes(tag) ||
      !(element instanceof HTMLElement || element instanceof SVGElement)
    )
      return;

    if (tag === "fade") {
      const anim = {
        _: {
          display: element.style.display,
          fadein: new Animation(new KeyframeEffect(element, { opacity: [0, 1] }, 700)),
          fadeout: new Animation(new KeyframeEffect(element, { opacity: [1, 0] }, 700)),
        },
        fadein: (): void => {
          if (element.style.display === "none") {
            element.style.display = anim._.display;
            anim._.fadein.play();
          }
        },
        fadeout: (): void => {
          if (element.style.display !== "none") {
            anim._.fadeout.play();
            anim._.fadeout.onfinish = () => {
              element.style.display = "none";
            };
          }
        },
      } as FadeAnimations;
      return anim;
    } else if (tag === "hover") {
      const opts = props?.hover;
      const defaultColor = element.style.color;
      if (typeof opts !== "object" || Array.isArray(opts)) return;

      if (typeof opts?.duration === "number")
        element.style.transitionDuration = `${opts.duration}ms`;

      if (typeof opts?.onhover === "string")
        element.onmouseenter = (): void => {
          element.style.color = opts.onhover;
        };
      else if (typeof opts?.onhover === "function") element.onmouseenter = opts.onhover;

      if (typeof opts?.onleave === "string")
        element.onmouseleave = (): void => {
          element.style.color = opts.onleave;
        };
      else if (typeof opts?.onleave === "function") element.onmouseleave = opts.onleave;
      else
        element.onmouseleave = (): void => {
          element.style.color = defaultColor;
        };
    } else if (tag === "scrolling") {
      const keyframes = [
        [
          { transform: "translateX(0)" },
          { transform: "translateX(0)", offset: 0.2 },
          {
            transform: `translateX(-${element.scrollWidth - element.offsetWidth}px)`,
            offset: 0.8,
          },
          { transform: `translateX(-${element.scrollWidth - element.offsetWidth}px)` },
        ],
        {
          iterations: Infinity,
          duration: (element.scrollWidth - element.offsetWidth) * 50,
          direction: "alternate-reverse",
          easing: "linear",
        },
      ];

      if (!instant) return new Animation(new KeyframeEffect(element, ...keyframes));
      else return element.animate(...keyframes);
    }
  },
  element(
    tag: string | { name: string; svg?: boolean },
    classes?: string,
    style?: string,
    attributes?: Record<string, string>,
    children?: Array<Node | HTMLElement | SVGElement>,
  ): undefined | HTMLElement | SVGElement {
    if (!tag || (typeof tag !== "string" && typeof tag !== "object") || Array.isArray(tag)) return;

    let element: HTMLElement | SVGElement;

    if (typeof tag === "string")
      element = !["path", "svg"].includes(tag)
        ? document.createElement(tag)
        : document.createElementNS("http://www.w3.org/2000/svg", tag);
    else if (typeof tag === "object" && typeof tag?.name === "string")
      element = tag?.svg
        ? document.createElementNS("http://www.w3.org/2000/svg", tag.name)
        : document.createElement(tag.name);
    else return;

    if (typeof classes === "string") element.classList.add(...classes.split(" "));

    if (typeof style === "string") {
      if (element instanceof HTMLElement) element.setAttribute("style", style);
      else element.setAttributeNS(null, "style", style);
    }

    if (typeof attributes === "object" && !Array.isArray(attributes))
      for (const [key, value] of Object.entries(attributes)) {
        if (element instanceof HTMLElement) element.setAttribute(key, value);
        else element.setAttributeNS(null, key, value);
      }

    if (children?.length)
      for (const child of children)
        if (child instanceof Node || child instanceof HTMLElement || child instanceof SVGElement)
          element.appendChild(child);

    return element;
  },
}; */
