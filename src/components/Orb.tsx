interface OrbProps {
  size?: 'sm' | 'lg';
}

/** Audio-reactive gradient orb. Reacts to the --out / --mic CSS vars set on .app */
export function Orb({ size = 'sm' }: OrbProps) {
  return (
    <div className={`orb orb-${size}`} aria-hidden="true">
      <span className="orb-glow" />
      <span className="orb-core" />
      <span className="orb-swirl" />
      <span className="orb-shine" />
    </div>
  );
}
