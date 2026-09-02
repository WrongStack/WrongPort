import { useEffect, useRef, useState } from 'react';

interface KillButtonProps {
  label: string;
  armedLabel: string;
  onConfirm: () => void;
  title?: string;
}

/** Two-step button: first click arms, second click within 2.5s fires. Blur disarms. */
export function KillButton({ label, armedLabel, onConfirm, title }: KillButtonProps) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const fire = () => {
    if (armed) {
      window.clearTimeout(timer.current);
      setArmed(false);
      onConfirm();
      return;
    }
    setArmed(true);
    timer.current = window.setTimeout(() => setArmed(false), 2500);
  };

  return (
    <button
      type="button"
      title={title}
      onClick={fire}
      onBlur={() => setArmed(false)}
      className={`rounded-md border px-2 py-1 font-mono text-xs font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
        armed
          ? 'border-danger bg-danger/20 text-danger hover:bg-danger/30'
          : 'border-border bg-raised text-muted hover:border-danger/50 hover:text-danger'
      }`}
    >
      {armed ? armedLabel : label}
    </button>
  );
}
