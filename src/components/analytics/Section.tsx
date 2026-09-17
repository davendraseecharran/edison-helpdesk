import type { ReactNode } from 'react';

/**
 * One panel of the page: a heading, one line saying what is counted, and the
 * charts. The line is in the head rather than the body so that every section
 * explains itself before a single mark is read, and so the body is nothing
 * but the figures.
 */
export function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel analytics-section" aria-labelledby={`${id}-title`}>
      <div className="panel-head analytics-head">
        <div className="analytics-head-text">
          <h2 id={`${id}-title`} className="panel-title">
            {title}
          </h2>
          <p className="panel-note">{note}</p>
        </div>
      </div>
      <div className="panel-body analytics-body">{children}</div>
    </section>
  );
}
