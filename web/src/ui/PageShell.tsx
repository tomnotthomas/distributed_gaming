import type { ReactNode } from "react";

type Props = {
  title: string;
  subtitle: string;
  /** Room tag, status line — anything identifying which connection this is. */
  meta?: ReactNode;
  children: ReactNode;
};

/** The page frame both peers share, so host and renter read as one product. */
export function PageShell({ title, subtitle, meta, children }: Props) {
  return (
    <main className="page">
      <header className="page-head">
        <h1 className="page-title">{title}</h1>
        <p className="page-sub">{subtitle}</p>
        {meta ? <div className="row">{meta}</div> : null}
      </header>
      {children}
    </main>
  );
}
