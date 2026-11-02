import { useState } from 'react';
import { AlertCircle, Check, ChevronDown, Eye, MousePointer2, MousePointerClick, ScanSearch, AlignLeft } from 'lucide-react';
import type { AgentActivity } from '../agent/screenAgent';

const ICONS = {
  look: Eye,
  zoom: ScanSearch,
  move: MousePointer2,
  click: MousePointerClick,
  error: AlertCircle,
  tree: AlignLeft,
} as const;

interface ActivityRowProps {
  steps: AgentActivity[];
  done: boolean;
}

/** A compact, expandable pill summarising what the agent did on screen. */
export function ActivityRow({ steps, done }: ActivityRowProps) {
  const [open, setOpen] = useState(false);
  const [previewImg, setPreviewImg] = useState<string | null>(null);

  const last = steps[steps.length - 1];
  const Icon = ICONS[last.kind];
  const isError = last.kind === 'error';
  const expandable = steps.length > 1;

  // Find the latest step that has an image captured
  const latestImage = [...steps].reverse().find((s): s is AgentActivity & { image: string } => 'image' in s && typeof (s as any).image === 'string')?.image;

  return (
    <div className={`activity ${done ? 'is-done' : 'is-working'} ${isError ? 'is-error' : ''}`}>
      <div className="activity-main-line">
        <button
          className="activity-pill"
          onClick={() => expandable && setOpen((o) => !o)}
          aria-expanded={open}
          disabled={!expandable}
        >
          <span className="activity-icon">
            <Icon size={14} />
          </span>
          <span className="activity-label">{last.label}</span>
          {done ? (
            !isError && <Check size={13} className="activity-check" />
          ) : (
            <span className="activity-spinner" />
          )}
          {expandable && <ChevronDown size={13} className={`activity-chevron ${open ? 'is-open' : ''}`} />}
        </button>

        {latestImage && (
          <button
            className="activity-thumb-btn"
            onClick={() => setPreviewImg(latestImage)}
            title="Click to view screen image"
          >
            <img src={latestImage} alt="Screen crop preview" className="activity-thumb" />
          </button>
        )}
      </div>

      {open && expandable && (
        <ol className="activity-steps">
          {steps.map((s, i) => {
            const StepIcon = ICONS[s.kind];
            const hasImg = 'image' in s && s.image;
            return (
              <li key={i}>
                <StepIcon size={12} />
                <span>{s.label}</span>
                {hasImg && (
                  <button
                    className="step-thumb-link"
                    onClick={() => setPreviewImg(s.image!)}
                    title="View this step's image"
                  >
                    view
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {previewImg && (
        <div className="img-modal-backdrop" onClick={() => setPreviewImg(null)}>
          <div className="img-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="img-modal-header">
              <span>What GridSight Sees (Annotated Screen Grid)</span>
              <button className="img-modal-close" onClick={() => setPreviewImg(null)}>
                ✕
              </button>
            </div>
            <img src={previewImg} alt="Annotated Screen View" className="img-modal-img" />
          </div>
        </div>
      )}
    </div>
  );
}
