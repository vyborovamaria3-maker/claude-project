import { Section, Cell } from '@telegram-apps/telegram-ui';
import React from 'react';

export const Card: React.FC<React.PropsWithChildren<{ className?: string }>> = ({ children, className }) => (
  <Section className={className}>
    <Cell>
      {children}
    </Cell>
  </Section>
);
