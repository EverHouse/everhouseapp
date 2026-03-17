import { haptic } from '../../../../utils/haptics';
import { postWithCredentials } from '../../../../hooks/queries/useFetch';
import type { CartItem, PaymentMethodType } from './posTypes';

interface PaymentState {
  cartItems: CartItem[];
  totalCents: number;
  paymentIntentId: string | null;
  clientSecret: string | null;
  selectedPaymentMethod: PaymentMethodType | null;
  useGuestCheckout: boolean;
  guestReceiptEmail: string;
  getCustomerInfo: () => {
    email: string;
    name: string;
    isNewCustomer: boolean;
    isGuestCheckout: boolean;
    id: string | null;
    firstName?: string;
    lastName?: string;
    phone?: string;
  } | null;
  buildDescription: () => string;
}

interface PaymentSetters {
  setClientSecret: (v: string | null) => void;
  setPaymentIntentId: (v: string | null) => void;
  setIsCreatingIntent: (v: boolean) => void;
  setIsProcessing: (v: boolean) => void;
  setError: (v: string | null) => void;
  setSuccess: (v: boolean) => void;
  setReceiptSent: (v: boolean) => void;
  setReceiptSending: (v: boolean) => void;
  setAttachingEmail: (v: boolean) => void;
  setSelectedPaymentMethod: (v: PaymentMethodType | null) => void;
}

export function createPaymentHandlers(state: PaymentState, setters: PaymentSetters) {
  const createPaymentIntent = async () => {
    const customer = state.getCustomerInfo();
    if ((!customer && !state.useGuestCheckout) || state.totalCents <= 0) return;

    setters.setIsCreatingIntent(true);
    setters.setError(null);

    try {
      const payload: Record<string, unknown> = {
        amountCents: state.totalCents,
        description: state.buildDescription(),
      };

      if (state.useGuestCheckout) {
        payload.guestCheckout = true;
      } else if (customer) {
        payload.memberEmail = customer.email;
        payload.memberName = customer.name;
      }

      if (state.cartItems.length === 1) {
        payload.productId = state.cartItems[0].productId;
      }

      if (state.cartItems.length > 0) {
        payload.cartItems = state.cartItems.map(item => ({
          productId: item.productId,
          name: item.name,
          priceCents: item.priceCents,
          quantity: item.quantity,
        }));
      }

      if (customer && 'isNewCustomer' in customer && customer.isNewCustomer) {
        payload.isNewCustomer = true;
        payload.firstName = (customer as { firstName?: string }).firstName;
        payload.lastName = (customer as { lastName?: string }).lastName;
        if ((customer as { phone?: string }).phone) {
          payload.phone = (customer as { phone?: string }).phone;
        }
      }

      const data = await postWithCredentials<{ clientSecret: string; paymentIntentId: string }>('/api/stripe/staff/quick-charge', payload);
      setters.setClientSecret(data.clientSecret);
      setters.setPaymentIntentId(data.paymentIntentId);
    } catch (err: unknown) {
      haptic.error();
      setters.setError((err instanceof Error ? err.message : String(err)) || 'Failed to create payment');
    } finally {
      setters.setIsCreatingIntent(false);
    }
  };

  const handleSelectPaymentMethod = async (method: PaymentMethodType) => {
    setters.setSelectedPaymentMethod(method);
    setters.setError(null);

    if (method === 'online_card' && !state.clientSecret) {
      await createPaymentIntent();
    }
  };

  const handleCardPaymentSuccess = async (piId?: string) => {
    const intentId = piId || state.paymentIntentId;
    if (!intentId) return;

    try {
      await postWithCredentials('/api/stripe/staff/quick-charge/confirm', { paymentIntentId: intentId });
    } catch (err: unknown) {
      console.error('[POS] Failed to confirm payment record:', err);
    }

    setters.setPaymentIntentId(intentId);
    setters.setSuccess(true);
    haptic.success();
  };

  const handleTerminalSuccess = async (piId: string) => {
    try {
      await postWithCredentials('/api/stripe/staff/quick-charge/confirm', { paymentIntentId: piId });
    } catch (err: unknown) {
      console.error('[POS] Failed to confirm terminal payment record:', err);
    }

    setters.setPaymentIntentId(piId);
    setters.setSuccess(true);
    haptic.success();
  };

  const handleSavedCardCharge = async () => {
    const customer = state.getCustomerInfo();
    if (!customer || state.totalCents <= 0) return;

    setters.setIsProcessing(true);
    setters.setError(null);

    try {
      const data = await postWithCredentials<{ paymentIntentId: string }>('/api/stripe/staff/charge-saved-card-pos', {
        memberEmail: customer.email,
        memberName: customer.name,
        amountCents: state.totalCents,
        description: state.buildDescription(),
        productId: state.cartItems.length === 1 ? state.cartItems[0].productId : undefined,
        cartItems: state.cartItems.map(item => ({
          productId: item.productId,
          name: item.name,
          priceCents: item.priceCents,
          quantity: item.quantity,
        })),
      });

      setters.setPaymentIntentId(data.paymentIntentId);
      setters.setSuccess(true);
      haptic.success();
    } catch (err: unknown) {
      haptic.error();
      setters.setError((err instanceof Error ? err.message : String(err)) || 'Failed to charge card on file');
    } finally {
      setters.setIsProcessing(false);
    }
  };

  const handleSendReceipt = async (overrideEmail?: string) => {
    const customer = state.getCustomerInfo();
    const email = overrideEmail || customer?.email;
    const name = customer?.name || 'Guest';
    if (!email) return;

    setters.setReceiptSending(true);
    try {
      const effectivePaymentMethod =
        state.selectedPaymentMethod === 'terminal'
          ? 'terminal'
          : 'card';

      await postWithCredentials('/api/purchases/send-receipt', {
        email,
        memberName: name,
        items: state.cartItems.map(item => ({
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.priceCents,
          total: item.priceCents * item.quantity,
        })),
        totalAmount: state.totalCents,
        paymentMethod: effectivePaymentMethod,
        paymentIntentId: state.paymentIntentId || undefined,
      });

      setters.setReceiptSent(true);
      haptic.success();
    } catch {
      haptic.error();
      setters.setError('Failed to send receipt');
    } finally {
      setters.setReceiptSending(false);
    }
  };

  const handleGuestReceiptSubmit = async () => {
    const email = state.guestReceiptEmail.trim().toLowerCase();
    if (!email || !state.paymentIntentId) return;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setters.setError('Please enter a valid email address');
      return;
    }

    setters.setAttachingEmail(true);
    setters.setError(null);

    try {
      await postWithCredentials('/api/stripe/staff/quick-charge/attach-email', { paymentIntentId: state.paymentIntentId, email }).catch((err: unknown) => {
        console.warn('[POS] Could not attach email to payment:', err instanceof Error ? err.message : err);
      });

      await handleSendReceipt(email);
    } catch (err: unknown) {
      console.error('[POS] Guest receipt submit error:', err);
      haptic.error();
      setters.setError('Failed to send receipt');
    } finally {
      setters.setAttachingEmail(false);
    }
  };

  return {
    handleSelectPaymentMethod,
    handleCardPaymentSuccess,
    handleTerminalSuccess,
    handleSavedCardCharge,
    handleSendReceipt,
    handleGuestReceiptSubmit,
  };
}
