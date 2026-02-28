import React from 'react';
import { Footer } from '../../components/Footer';
import SEO from '../../components/SEO';

const TermsOfService: React.FC = () => {
  return (
    <div className="min-h-screen bg-bone dark:bg-[#293515] text-primary dark:text-bone pt-24 pb-12">
      <SEO title="Terms of Service | Ever Club" description="Ever Club terms of service and conditions for membership at our indoor golf & social club in Tustin, Orange County." url="/terms" />
      <div className="max-w-4xl mx-auto px-6">
        <h1 className="text-3xl sm:text-4xl md:text-5xl mb-8 leading-none" style={{ fontFamily: 'var(--font-display)' }}>Membership Terms & Conditions</h1>
        <p className="text-sm opacity-60 mb-12">Effective Date: January 20, 2026</p>

        <div className="space-y-8 leading-relaxed text-base" style={{ fontFamily: 'var(--font-body)' }}>
          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>1. Agreement Overview</h2>
            <p>
              This Membership Agreement ("Agreement") outlines the terms and conditions of membership at Ever Members Club, doing business as Ever Club (the "Club"). By becoming an Ever Club member (or guest of a member), you agree to abide by this Agreement and all Club rules. This Agreement is intended to protect our members, guests, and the Club.
            </p>
          </section>

          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>2. Membership Term and Renewal</h2>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Term Length:</strong> Membership is offered on an annual basis (12-month term). Your membership will begin on the start date confirmed by the Club and continue for one year.</li>
              <li><strong>Automatic Renewal:</strong> Membership will automatically renew for successive one-year terms at the then-current membership dues unless you or the Club terminate as described below.</li>
              <li><strong>Cancellation:</strong> If you do not wish to renew, you must provide Ever Club written notice at least 30 days before your term ends. You may cancel at the end of your current annual term with no penalty by giving this advance notice. Initiation fees are non-refundable.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>3. Fees and Payments</h2>
            <p className="mb-4">
              Membership dues are payable in advance (monthly or annually). By providing your payment information, you authorize Ever Club to charge your designated payment method for all dues, fees, and house charges incurred.
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Late Payments:</strong> If your payment method declines or your account becomes past due, the Club may suspend access to facilities until the balance is paid.</li>
              <li><strong>Price Changes:</strong> The Club may adjust membership dues for each renewal term. You will be notified of any changes at least 30 days before renewal.</li>
            </ul>
          </section>

          <section className="bg-white/50 dark:bg-white/5 p-6 rounded-xl border border-primary/10 dark:border-white/10">
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>4. Liability Waiver</h2>
            <p className="font-bold mb-2">Please read carefully:</p>
            <p className="mb-4">
              To the maximum extent allowed by law, you release Ever Club, its owners, partners, employees, and agents from any and all liability or claims for property damage, personal injury, illness, or death arising out of or relating to your membership or presence at the Club.
            </p>
            <p className="mb-4">
              This waiver applies to any injuries or damages occurring on the Club premises or during Club-sponsored activities, whether caused by inherent risks (e.g. being struck by a golf ball) or by negligence of the Club or its staff.
            </p>
            <p>
              You understand and voluntarily accept all risks inherent in using the Club, including but not limited to: athletic injuries, equipment malfunctions, or interactions with other members. You agree to use facilities safely and within your personal limits.
            </p>
          </section>

          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>5. Code of Conduct</h2>
            <p className="mb-4">
              Members must treat all staff and other members with respect. The Club reserves the right to suspend or terminate membership for behavior deemed detrimental to the Club community, including:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Harassment or discrimination of any kind</li>
              <li>Property damage or theft</li>
              <li>Failure to pay dues or outstanding balances</li>
              <li>Violation of Club rules or policies</li>
              <li>Conduct that endangers the safety of others</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>6. Guest Policy</h2>
            <p>
              Members may bring guests to the Club subject to guest fees and policies. Members are responsible for the conduct of their guests and must accompany them at all times. Guest privileges may be limited based on membership tier.
            </p>
          </section>

          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>7. Facility Rules</h2>
            <p className="mb-4">
              All members and guests must adhere to posted facility rules, including but not limited to:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Proper attire in designated areas</li>
              <li>Booking and cancellation policies for simulators and amenities</li>
              <li>Food and beverage policies</li>
              <li>Hours of operation</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>8. Privacy</h2>
            <p>
              Your privacy is important to us. Please review our <a href="/privacy" className="underline font-bold hover:opacity-80 transition-opacity">Privacy Policy</a> to understand how we collect, use, and protect your personal information.
            </p>
          </section>

          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>9. Modifications</h2>
            <p>
              Ever Club reserves the right to modify these terms and conditions at any time. Members will be notified of material changes via email or through the member portal. Continued use of Club facilities after such changes constitutes acceptance of the modified terms.
            </p>
          </section>
          
          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>10. Contact Information</h2>
            <p>
              Questions about the Terms of Service should be sent to us at <a href="mailto:info@everclub.app" className="underline font-bold hover:opacity-80 transition-opacity">info@everclub.app</a>.
            </p>
          </section>
        </div>
      </div>
      <Footer />
    </div>
  );
};

export default TermsOfService;
