import React from 'react';
import { Footer } from '../../components/Footer';
import SEO from '../../components/SEO';

const PrivacyPolicy: React.FC = () => {
  return (
    <div className="min-h-screen bg-bone dark:bg-[#293515] text-primary dark:text-bone pt-24 pb-12">
      <SEO title="Privacy Policy | Ever Club" description="Ever Club privacy policy. Learn how we collect, use, and protect your personal information at our Tustin, CA indoor golf & social club." url="/privacy" />
      <div className="max-w-4xl mx-auto px-6">
        <h1 className="text-3xl sm:text-4xl md:text-5xl mb-8 leading-none" style={{ fontFamily: 'var(--font-display)' }}>Privacy Policy</h1>
        <p className="text-sm opacity-60 mb-12">Last updated: January 20, 2026</p>

        <div className="space-y-8 leading-relaxed text-base" style={{ fontFamily: 'var(--font-body)' }}>
          <section>
            <p>
              This Privacy Policy describes how everclub.app and related Ever Members Club services (the "Site," "we," "us," or "our") collect, use, and disclose your personal information when you visit our website, contact us, use our services, or make a purchase.
            </p>
          </section>

          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Collecting Personal Information</h2>
            <p className="mb-4">
              When you visit the Site, we collect certain information about your device, your interaction with the Site, and information necessary to process your purchases. We may also collect additional information if you contact us for customer support.
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong>Device Information:</strong> Examples include version of web browser, IP address, time zone, cookie information, what sites or products you view, search terms, and how you interact with the Site.
              </li>
              <li>
                <strong>Order Information:</strong> Name, billing address, shipping address, payment information (including credit card numbers), email address, and phone number.
              </li>
              <li>
                <strong>Member Information:</strong> Date of birth, profile photos, and handicap information for club activities.
              </li>
            </ul>
          </section>

          <section className="bg-white/50 dark:bg-white/5 p-6 rounded-xl border border-primary/10 dark:border-white/10">
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Text Messaging & SMS Privacy</h2>
            <p className="mb-4">
              We value your privacy and the information you consent to share in relation to our SMS marketing service. We use this information to send you text notifications (for your bookings, including abandoned checkout reminders), marketing offers, and transactional texts, including requests for reviews from us.
            </p>
            
            <h3 className="font-bold text-lg mb-2">Collection of Number</h3>
            <ul className="list-disc pl-5 space-y-2 mb-4">
              <li><strong>Purpose:</strong> To send you text messages you opted in to receive (membership updates, booking notifications, event reminders).</li>
              <li><strong>Source:</strong> Collected from you when you provide your mobile number and opt in to receive text messages.</li>
              <li><strong>Disclosure:</strong> Shared with our communications service providers solely to deliver messages and support our messaging program.</li>
            </ul>

            <h3 className="font-bold text-lg mb-2">Compliance Statement</h3>
            <p className="italic font-medium mb-4">
              "No mobile information will be shared with third parties/affiliates for marketing/promotional purposes. All other categories exclude text messaging originator opt-in data and consent; this information will not be shared with any third parties."
            </p>

            <h3 className="font-bold text-lg mb-2">Opt-Out</h3>
            <p>
              If you are receiving text messages from us and wish to stop receiving them, simply reply STOP to the number from which you received the message. You will not receive further text messages from us unless you opt in again.
            </p>
          </section>

          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Sharing Personal Information</h2>
            <p>
              We share your Personal Information with service providers to help us provide our services and fulfill our contracts with you, as described above. For example, we use Stripe for payment processing and HubSpot for customer relationship management.
            </p>
          </section>

          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Your Rights</h2>
            <p className="mb-4">
              If you are a resident of California, you have the right to access the personal information we hold about you, to port it to a new service, and to ask that your personal information be corrected, updated, or erased.
            </p>
            <p>
              If you would like to exercise these rights, please contact us using the contact information below.
            </p>
          </section>

          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Data Retention</h2>
            <p>
              When you place an order or make a booking through the Site, we will maintain your Order Information for our records unless and until you ask us to delete this information.
            </p>
          </section>

          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Changes</h2>
            <p>
              We may update this privacy policy from time to time in order to reflect, for example, changes to our practices or for other operational, legal or regulatory reasons.
            </p>
          </section>

          <section>
            <h2 className="text-2xl mb-4 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Contact Us</h2>
            <p>
              For more information about our privacy practices, if you have questions, or if you would like to make a complaint, please contact us by email at <a href="mailto:info@everclub.app" className="underline font-bold hover:opacity-80 transition-opacity">info@everclub.app</a>.
            </p>
          </section>
        </div>
      </div>
      <Footer />
    </div>
  );
};

export default PrivacyPolicy;
