import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MicOff, VideoOff } from 'lucide-react';
import type { CallSnapshot } from '../../call/CallSession';
import { initialOf } from '../../lib/format';
import { safePlay } from '../../lib/play';

interface LocalPipProps {
  snapshot: CallSnapshot;
  displayName: string;
  label: string;
  onFlip: () => void;
}

const STORAGE_KEY = 'rc:pip';

interface PipPosition {
  x: number; // fraction of the free area (0..1)
  y: number;
}

const PIP_GAP = 14;

/** Floating self-view. Draggable with pointer events; clamps to the stage. */
export function LocalPip({ snapshot, displayName, label, onFlip }: LocalPipProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pipRef = useRef<HTMLDivElement>(null);
  const [videoReady, setVideoReady] = useState(false);
  const initialPosition = useMemo((): PipPosition => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PipPosition;
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed;
      }
    } catch {
      // fall back to default position
    }
    return { x: 1, y: 0 }; // top-right
  }, []);
  const positionRef = useRef<PipPosition>(initialPosition);
  const draggingRef = useRef(false);

  const videoTrack = snapshot.localStream?.getVideoTracks().find(track => track.readyState === 'live');
  const videoVisible = Boolean(videoTrack && videoTrack.enabled);

  const applyPosition = useCallback((next: PipPosition, host: HTMLDivElement | null, pip: HTMLDivElement | null) => {
    if (!host || !pip) return;
    const freeWidth = Math.max(0, host.clientWidth - pip.offsetWidth - PIP_GAP * 2);
    const freeHeight = Math.max(0, host.clientHeight - pip.offsetHeight - PIP_GAP * 2);
    const x = Math.min(1, Math.max(0, next.x));
    const y = Math.min(1, Math.max(0, next.y));
    positionRef.current = { x, y };
    pip.style.left = `${PIP_GAP + x * freeWidth}px`;
    pip.style.top = `${PIP_GAP + y * freeHeight}px`;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y }));
    } catch {
      // ignore storage failures
    }
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const pip = pipRef.current;
    if (!host || !pip) return;
    applyPosition(positionRef.current, host, pip);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => applyPosition(positionRef.current, host, pip));
    observer.observe(host);
    return () => observer.disconnect();
  }, [applyPosition]);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    const host = hostRef.current;
    const pip = pipRef.current;
    if (!host || !pip) return;
    event.preventDefault();
    draggingRef.current = true;
    pip.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY };
    const startPos = { ...positionRef.current };
    const freeWidth = Math.max(0, host.clientWidth - pip.offsetWidth - PIP_GAP * 2);
    const freeHeight = Math.max(0, host.clientHeight - pip.offsetHeight - PIP_GAP * 2);

    const onMove = (move: PointerEvent) => {
      if (!draggingRef.current) return;
      const dx = move.clientX - start.x;
      const dy = move.clientY - start.y;
      const next = {
        x: freeWidth > 0 ? startPos.x + dx / freeWidth : startPos.x,
        y: freeHeight > 0 ? startPos.y + dy / freeHeight : startPos.y,
      };
      applyPosition(next, host, pip);
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [applyPosition]);

  const showAvatar = !videoVisible || !videoReady;

  return (
    <div className="local-pip-host" ref={hostRef} aria-hidden="false">
      <div
        ref={pipRef}
        className={'pip' + (draggingRef.current ? ' dragging' : '')}
        role="group"
        aria-label={label}
        onPointerDown={onPointerDown}
        onDoubleClick={event => {
          event.stopPropagation();
          onFlip();
        }}
        onContextMenu={event => event.preventDefault()}
      >
        <video
          className="pip-video"
          autoPlay
          muted
          playsInline
          data-hidden={showAvatar ? 'true' : undefined}
          ref={node => {
            if (!node) return;
            const stream = snapshot.localStream;
            if (node.srcObject !== stream) {
              node.srcObject = stream;
              if (stream) {
                safePlay(node);
                const check = () => {
                  setVideoReady(node.readyState >= 2 && node.videoWidth > 0);
                };
                node.addEventListener('loadeddata', check, { once: true });
                setTimeout(check, 400);
              } else {
                setVideoReady(false);
              }
            }
          }}
        />
        {showAvatar ? (
          <span className="pip-avatar" data-size={undefined}>
            {snapshot.localVideoEnabled ? initialOf(displayName) : <VideoOff size={18} aria-hidden="true" />}
          </span>
        ) : null}
        <span className="pip-badge" data-tone={snapshot.localMuted ? 'muted' : undefined} aria-hidden="true">
          {snapshot.localMuted ? <MicOff size={11} /> : null}
        </span>
        <span className="pip-label">{label}</span>
      </div>
    </div>
  );
}
