import type { Metadata } from 'next';

import { Assistant } from '@/features/assistant/Assistant';

export const metadata: Metadata = {
  title: 'API Assistant',
  description:
    'Describe your project and get grounded API recommendations with real reasons and honest caveats.',
};

export default function AssistantPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-12) var(--space-16)' }}>
      <header style={{ textAlign: 'center', marginBottom: 'var(--space-8)' }}>
        <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: 'var(--tracking-tight)' }}>
          What are you building?
        </h1>
        <p
          style={{
            marginTop: 'var(--space-3)',
            color: 'var(--text-muted)',
            fontSize: 'var(--text-md)',
            maxWidth: '60ch',
            marginInline: 'auto',
            lineHeight: 'var(--leading-relaxed)',
          }}
        >
          Describe your project in plain English. APIHub extracts the constraints, searches the
          catalogue and ranks the results — then tells you exactly why each one was chosen and what
          the trade-offs are.
        </p>
      </header>

      <Assistant />
    </div>
  );
}
