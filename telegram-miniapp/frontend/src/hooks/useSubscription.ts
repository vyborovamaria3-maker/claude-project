import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { getTelegramUser } from '../lib/telegram';

interface SubscriptionState {
  active: boolean;
  loading: boolean;
  subscriptionEnd: Date | null;
  userExists: boolean;
  error: string | null;
}

export function useSubscription() {
  const [state, setState] = useState<SubscriptionState>({
    active: false,
    loading: true,
    subscriptionEnd: null,
    userExists: false,
    error: null,
  });

  const checkSubscription = useCallback(async () => {
    const user = getTelegramUser();
    if (!user) {
      setState(prev => ({ ...prev, loading: false, error: 'Not in Telegram' }));
      return;
    }

    try {
      const response = await api.getSubscriptionStatus(user.id);
      
      if (response.success && response.data) {
        const { active, subscriptionEnd, userExists } = response.data;
        setState({
          active,
          loading: false,
          subscriptionEnd: subscriptionEnd ? new Date(subscriptionEnd) : null,
          userExists,
          error: null,
        });
      } else {
        setState(prev => ({
          ...prev,
          loading: false,
          error: response.error || 'Failed to check subscription',
        }));
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: 'Network error',
      }));
    }
  }, []);

  useEffect(() => {
    checkSubscription();

    // Poll every 5 seconds to check for payment confirmation
    const interval = setInterval(() => {
      checkSubscription();
    }, 5000);

    return () => clearInterval(interval);
  }, [checkSubscription]);

  return {
    ...state,
    refresh: checkSubscription,
  };
}
