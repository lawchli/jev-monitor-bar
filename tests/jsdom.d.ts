declare module 'jsdom' {
  interface JsdomWindow {
    document: Document;
    HTMLElement: typeof HTMLElement;
    Node: typeof Node;
    navigator: Navigator;
    MouseEvent: typeof MouseEvent;
    Event: typeof Event;
    HTMLSelectElement: typeof HTMLSelectElement;
    HTMLInputElement: typeof HTMLInputElement;
    close(): void;
  }
  export class JSDOM {
    window: JsdomWindow;
    constructor(html?: string);
  }
}
