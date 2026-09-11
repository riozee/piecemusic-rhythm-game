export interface ViewportLayout {
  isPortrait: boolean;
  containerWidth: number;
  containerHeight: number;
  transform: string;
  transformOrigin: string;
  physicalWidth: number;
  physicalHeight: number;
}

/**
 * ViewportManager
 *
 * Handles fullscreen management and auto-rotation:
 * - If portrait: rotates the container 90 degrees so the viewport becomes landscape.
 * - If landscape: leaves layout untouched ("do nothing").
 */
export class ViewportManager {
  private onChangeCallbacks = new Set<(layout: ViewportLayout) => void>();
  private currentLayout: ViewportLayout = this.computeLayout();

  constructor() {
    this.initListeners();
  }

  private initListeners(): void {
    const onResize = () => {
      this.currentLayout = this.computeLayout();
      this.notify();
    };

    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onResize, { passive: true });
    }

    document.addEventListener('fullscreenchange', onResize, { passive: true });
    document.addEventListener('webkitfullscreenchange', onResize, { passive: true });
  }

  public getLayout(): ViewportLayout {
    return this.currentLayout;
  }

  public subscribe(cb: (layout: ViewportLayout) => void): () => void {
    this.onChangeCallbacks.add(cb);
    cb(this.currentLayout);
    return () => this.onChangeCallbacks.delete(cb);
  }

  private notify(): void {
    for (const cb of this.onChangeCallbacks) {
      cb(this.currentLayout);
    }
  }

  /**
   * Calculates the container dimensions and rotation transform.
   */
  public computeLayout(): ViewportLayout {
    const physicalWidth = window.visualViewport?.width || window.innerWidth;
    const physicalHeight = window.visualViewport?.height || window.innerHeight;

    const isPortrait = physicalWidth < physicalHeight;

    if (isPortrait) {
      // Screen is portrait: Rotate 90deg clockwise to render in landscape
      // Container width becomes physical height, container height becomes physical width
      const containerWidth = physicalHeight;
      const containerHeight = physicalWidth;

      return {
        isPortrait: true,
        containerWidth,
        containerHeight,
        transform: `translate(${physicalWidth}px, 0px) rotate(90deg)`,
        transformOrigin: '0 0',
        physicalWidth,
        physicalHeight,
      };
    } else {
      // Screen is already landscape: do nothing
      return {
        isPortrait: false,
        containerWidth: physicalWidth,
        containerHeight: physicalHeight,
        transform: 'none',
        transformOrigin: '0 0',
        physicalWidth,
        physicalHeight,
      };
    }
  }

  /**
   * Requests fullscreen mode on the document root.
   */
  public async requestFullscreen(): Promise<boolean> {
    try {
      const docEl = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void>;
        mozRequestFullScreen?: () => Promise<void>;
        msRequestFullscreen?: () => Promise<void>;
      };

      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      }

      // If supported (e.g. mobile Chrome), also lock screen orientation to landscape
      if ('orientation' in screen && 'lock' in (screen.orientation as any)) {
        try {
          await (screen.orientation as any).lock('landscape').catch(() => {});
        } catch {
          // Orientation lock is often restricted to installed PWAs, ignore
        }
      }

      return true;
    } catch (err) {
      console.warn('Fullscreen request rejected or not permitted yet:', err);
      return false;
    }
  }

  /**
   * Helper to map touch/click client coordinates back to landscape game coordinates
   * when screen is rotated in portrait mode.
   */
  public mapScreenToGameCoords(screenX: number, screenY: number): { x: number; y: number } {
    if (!this.currentLayout.isPortrait) {
      return { x: screenX, y: screenY };
    }

    // Rotated 90deg clockwise with translate(physicalWidth, 0):
    // screenX = physicalWidth - gameY  =>  gameY = physicalWidth - screenX
    // screenY = gameX                  =>  gameX = screenY
    return {
      x: screenY,
      y: this.currentLayout.physicalWidth - screenX,
    };
  }

  public isFullscreen(): boolean {
    const doc = document as Document & {
      webkitFullscreenElement?: Element;
      mozFullScreenElement?: Element;
      msFullscreenElement?: Element;
    };
    return !!(
      doc.fullscreenElement ||
      doc.webkitFullscreenElement ||
      doc.mozFullScreenElement ||
      doc.msFullscreenElement
    );
  }
}
