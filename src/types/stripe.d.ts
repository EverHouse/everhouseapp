declare namespace JSX {
  interface IntrinsicElements {
    'stripe-pricing-table': React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        'pricing-table-id': string;
        'publishable-key': string;
        'customer-email'?: string;
        'customer-session-client-secret'?: string;
      },
      HTMLElement
    >;
  }
}
