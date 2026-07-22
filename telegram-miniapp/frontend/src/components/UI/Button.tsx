import { Button as TelegramButton } from '@telegram-apps/telegram-ui';
import React from 'react';

type Props = React.ComponentProps<typeof TelegramButton> & { variant?: 'primary' | 'ghost' };

export const Button: React.FC<Props> = ({ variant = 'primary', className, children, ...rest }) => (
  <TelegramButton
    mode={variant === 'primary' ? 'filled' : 'plain'}
    className={className}
    {...rest}
  >
    {children}
  </TelegramButton>
);
