import type { ReactNode } from "react";

export interface PanelCardProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function PanelCard({ title, actions, children }: PanelCardProps) {
  return (
    <section className="panel-card">
      <div className="panel-card__header">
        <h2>{title}</h2>
        {actions ? <div className="panel-card__actions">{actions}</div> : null}
      </div>
      <div className="panel-card__body">{children}</div>
    </section>
  );
}
