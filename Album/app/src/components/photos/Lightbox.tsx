import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../common/Icon';

interface Props {
  src: string;
  alt: string;
  title: string;
  counter?: string | undefined;
  onClose: () => void;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}

interface View {
  scale: number;
  x: number;
  y: number;
}

const MAX_SCALE = 8;

/**
 * Full-screen viewer. Wheel, pinch, +/−, or double-click zoom around the pointer; drag pans; 0 fits and 1 shows
 * actual pixels; ←/→ step through photos; Esc closes. Built on <dialog> for focus handling.
 */
export function Lightbox({ src, alt, title, counter, onClose, onPrev, onNext }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; scale: number } | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  useEffect(() => setNatural(null), [src]);

  const box = () => {
    const r = stage.current?.getBoundingClientRect();
    return { w: r?.width ?? window.innerWidth, h: r?.height ?? window.innerHeight, left: r?.left ?? 0, top: r?.top ?? 0 };
  };
  const fitScale = useCallback(() => {
    if (!natural) return 1;
    const b = box();
    return Math.min(1, b.w / natural.w, b.h / natural.h);
  }, [natural]);

  /** Keeps the image centred when smaller than the stage and covering it when larger. */
  const clamp = useCallback(
    (v: View): View => {
      if (!natural) return v;
      const b = box();
      const w = natural.w * v.scale;
      const h = natural.h * v.scale;
      const x = w <= b.w ? (b.w - w) / 2 : Math.min(0, Math.max(b.w - w, v.x));
      const y = h <= b.h ? (b.h - h) / 2 : Math.min(0, Math.max(b.h - h, v.y));
      return { scale: v.scale, x, y };
    },
    [natural],
  );

  const fit = useCallback(() => setView(clamp({ scale: fitScale(), x: 0, y: 0 })), [clamp, fitScale]);
  useLayoutEffect(() => {
    if (natural) fit();
  }, [natural, fit]);
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [fit]);

  /** Zoom to `scale`, keeping the image point under (px, py) — stage coordinates — in place. */
  const zoomAt = useCallback(
    (target: number, px?: number, py?: number) => {
      setView((v) => {
        const b = box();
        const cx = px ?? b.w / 2;
        const cy = py ?? b.h / 2;
        const scale = Math.min(MAX_SCALE, Math.max(fitScale(), target));
        const k = scale / v.scale;
        return clamp({ scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
      });
    },
    [clamp, fitScale],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') zoomAt(view.scale * 1.5);
      else if (e.key === '-' || e.key === '_') zoomAt(view.scale / 1.5);
      else if (e.key === '0') fit();
      else if (e.key === '1') zoomAt(1);
      else if (e.key === 'ArrowLeft' && onPrev) onPrev();
      else if (e.key === 'ArrowRight' && onNext) onNext();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view.scale, zoomAt, fit, onPrev, onNext]);

  // Native, non-passive listener: React's wheel handler cannot stop the page behind from scrolling.
  const wheel = useRef<(e: WheelEvent) => void>(() => undefined);
  wheel.current = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e);
    zoomAt(view.scale * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
  };
  useEffect(() => {
    const el = stage.current;
    const onWheel = (e: WheelEvent) => wheel.current(e);
    el?.addEventListener('wheel', onWheel, { passive: false });
    return () => el?.removeEventListener('wheel', onWheel);
  }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const b = box();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const fitted = view.scale <= fitScale() * 1.001;
  const percent = Math.round(view.scale * 100);

  return (
    <dialog
      ref={dialog}
      className="lightbox"
      aria-label={`${title}, full size`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="lightbox-bar">
        <div className="lightbox-title">
          <strong>{title}</strong>
          {counter && <span>{counter}</span>}
        </div>
        <div className="lightbox-tools" role="toolbar" aria-label="Zoom">
          <button type="button" className="lb-btn" aria-label="Zoom out (−)" onClick={() => zoomAt(view.scale / 1.5)} disabled={fitted}>
            <Icon name="zoomOut" />
          </button>
          <button type="button" className="lb-zoom" onClick={fit} title="Fit to screen (0)">
            {percent}%
          </button>
          <button type="button" className="lb-btn" aria-label="Zoom in (+)" onClick={() => zoomAt(view.scale * 1.5)} disabled={view.scale >= MAX_SCALE}>
            <Icon name="zoomIn" />
          </button>
          <button type="button" className="lb-text" onClick={() => zoomAt(1)} title="Actual size (1)">
            1:1
          </button>
          <button type="button" className="lb-btn" aria-label="Close (Esc)" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
      </div>

      <div
        ref={stage}
        className={`lightbox-stage${fitted ? '' : ' is-zoomed'}`}
        onDoubleClick={(e) => {
          const p = local(e);
          if (fitted) zoomAt(Math.max(1, fitScale() * 2.5), p.x, p.y);
          else fit();
        }}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          pointers.current.set(e.pointerId, local(e));
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            gesture.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), scale: view.scale };
            drag.current = null;
          } else {
            const p = local(e);
            drag.current = { x: p.x, y: p.y, vx: view.x, vy: view.y };
          }
        }}
        onPointerMove={(e) => {
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, local(e));
          if (gesture.current && pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
            zoomAt(gesture.current.scale * (dist / gesture.current.dist), (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
          } else if (drag.current) {
            const p = local(e);
            const d = drag.current;
            setView((v) => clamp({ scale: v.scale, x: d.vx + p.x - d.x, y: d.vy + p.y - d.y }));
          }
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) gesture.current = null;
          if (pointers.current.size === 0) drag.current = null;
        }}
        onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
      >
        {!natural && <span className="spinner spinner-light" aria-label="Loading full-size image" />}
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          style={{
            width: natural?.w,
            height: natural?.h,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            visibility: natural ? 'visible' : 'hidden',
          }}
        />
        {onPrev && (
          <button type="button" className="lb-nav lb-prev" aria-label="Previous photo (←)" onClick={onPrev} onPointerDown={(e) => e.stopPropagation()}>
            <Icon name="chevronLeft" size={26} />
          </button>
        )}
        {onNext && (
          <button type="button" className="lb-nav lb-next" aria-label="Next photo (→)" onClick={onNext} onPointerDown={(e) => e.stopPropagation()}>
            <Icon name="chevronRight" size={26} />
          </button>
        )}
      </div>
      <p className="lightbox-hint" aria-hidden="true">
        Scroll or pinch to zoom · drag to move · double-click to switch between fit and full size
      </p>
    </dialog>
  );
}
