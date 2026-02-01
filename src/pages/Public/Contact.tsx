import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import Input from '../../components/Input';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useNavigationLoading } from '../../contexts/NavigationLoadingContext';
import { AnimatedPage } from '../../components/motion';
import { getApiErrorMessage, getNetworkErrorMessage } from '../../utils/errorHandling';

const Contact: React.FC = () => {
  const navigate = useNavigate();
  const { startNavigation } = useNavigationLoading();
  const { setPageReady } = usePageReady();
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    topic: 'Membership Inquiry',
    fullName: '',
    email: '',
    message: ''
  });

  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/hubspot/forms/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: [
            { name: 'topic', value: formData.topic },
            { name: 'firstname', value: formData.fullName.split(' ')[0] || '' },
            { name: 'lastname', value: formData.fullName.split(' ').slice(1).join(' ') || '' },
            { name: 'email', value: formData.email },
            { name: 'message', value: formData.message }
          ],
          context: {
            pageUri: window.location.href,
            pageName: 'Contact'
          }
        })
      });

      if (!response.ok) {
        setError(getApiErrorMessage(response, 'submit form'));
        return;
      }

      setIsSubmitted(true);
      setFormData({ topic: 'Membership Inquiry', fullName: '', email: '', message: '' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(getNetworkErrorMessage());
    } finally {
      setLoading(false);
    }
  };

  return (
    <AnimatedPage>
    <div className="flex flex-col min-h-screen bg-[#F2F2EC] overflow-x-hidden">
      <div className="px-6 pt-4 md:pt-2 pb-6 text-center animate-content-enter">
        <h1 className="text-3xl font-bold tracking-tight text-primary mb-3">Get in Touch</h1>
        <p className="text-primary/70 text-sm leading-relaxed max-w-xs mx-auto">
           We look forward to hearing from you. Please fill out the form below or visit us in Tustin.
        </p>
      </div>

      <section className="px-4 mb-8 space-y-3 animate-content-enter-delay-1">
           <ContactCard icon="location_on" title="VISIT US" value="15771 Red Hill Ave, Ste 500" />
           <ContactCard icon="call" title="CALL US" value="(949) 545-5855" href="tel:9495455855" />
           <ContactCard icon="mail" title="EMAIL US" value="info@evenhouse.club" href="mailto:info@evenhouse.club" />
           <a 
             href="https://bcrw.apple.com/urn:biz:91355ac7-f202-440d-a19e-f5a1cca16848" 
             target="_blank" 
             rel="noopener noreferrer"
             className="group flex items-center justify-between bg-zinc-700 p-4 rounded-2xl border border-black/5 shadow-sm hover:shadow-md transition-all cursor-pointer"
           >
              <div className="flex items-center gap-4">
                   <div className="flex items-center justify-center size-12 rounded-full bg-white/10 text-white shrink-0">
                       <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                         <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
                       </svg>
                   </div>
                   <div className="flex-1 min-w-0 text-left">
                       <p className="text-[10px] font-bold text-white/50 uppercase tracking-widest mb-0.5">MESSAGE US</p>
                       <p className="text-white font-bold truncate text-sm">Apple Messages</p>
                   </div>
              </div>
              <span className="material-symbols-outlined text-white/30 group-hover:text-white transition-colors">chevron_right</span>
           </a>
      </section>

      <section className="px-4 mb-8">
         <div className="bg-[#E8E8E0]/50 rounded-2xl p-6">
            <h3 className="text-lg font-bold text-primary mb-4 flex items-center gap-2">
               <span className="material-symbols-outlined text-xl">schedule</span>
               Hours of Operation
            </h3>
            <div className="space-y-3 text-sm">
               <div className="flex justify-between items-center pb-2 border-b border-primary/5">
                  <span className="text-primary/70 font-medium">Monday</span>
                  <span className="text-primary font-bold">Closed</span>
               </div>
               <div className="flex justify-between items-center pb-2 border-b border-primary/5">
                  <span className="text-primary/70 font-medium">Tue – Thu</span>
                  <span className="text-primary font-bold">8:30 AM – 8:00 PM</span>
               </div>
               <div className="flex justify-between items-center pb-2 border-b border-primary/5">
                  <span className="text-primary/70 font-medium">Fri – Sat</span>
                  <span className="text-primary font-bold">8:30 AM – 10:00 PM</span>
               </div>
               <div className="flex justify-between items-center">
                  <span className="text-primary/70 font-medium">Sunday</span>
                  <span className="text-primary font-bold">8:30 AM – 6:00 PM</span>
               </div>
            </div>
         </div>
      </section>

      <section className="px-4 mb-12">
         <div className="bg-white rounded-[2rem] p-6 shadow-sm border border-black/5">
            <h2 className="text-xl font-bold text-primary mb-6">Send a Message</h2>
            
            {isSubmitted ? (
                <div className="py-12 flex flex-col items-center text-center animate-in fade-in zoom-in duration-500">
                    <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center text-green-600 mb-4">
                        <span className="material-symbols-outlined text-3xl">check</span>
                    </div>
                    <h3 className="text-xl font-bold text-primary mb-2">Message Sent</h3>
                    <p className="text-primary/60">Thank you for reaching out. Our team will respond to your inquiry shortly.</p>
                    <button 
                        onClick={() => setIsSubmitted(false)}
                        className="mt-6 text-sm font-bold text-primary underline hover:text-accent"
                    >
                        Send another message
                    </button>
                </div>
            ) : (
                <form className="space-y-5" onSubmit={handleSubmit}>
                {error && (
                  <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg text-sm">
                    {error}
                  </div>
                )}
                <div className="relative">
                    <label className="block text-sm font-medium text-primary mb-1.5 pl-1">Topic</label>
                    <div className="relative">
                        <select 
                          value={formData.topic}
                          onChange={(e) => setFormData(prev => ({ ...prev, topic: e.target.value }))}
                          className="w-full bg-white border border-gray-200 rounded-lg py-3 pl-4 pr-10 text-primary focus:ring-2 focus:ring-primary focus:border-primary sm:text-sm sm:leading-6 appearance-none"
                        >
                            <option>Membership Inquiry</option>
                            <option>Private Events</option>
                            <option>General Information</option>
                        </select>
                        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-gray-500">
                            <span className="material-symbols-outlined">expand_more</span>
                        </div>
                    </div>
                </div>
                <Input 
                  label="Full Name" 
                  placeholder="Jane Doe" 
                  value={formData.fullName}
                  onChange={(e) => setFormData(prev => ({ ...prev, fullName: e.target.value }))}
                  variant="solid"
                  required 
                />
                <Input 
                  label="Email Address" 
                  type="email" 
                  placeholder="jane@example.com" 
                  value={formData.email}
                  onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                  variant="solid"
                  required 
                />
                <div>
                    <label className="block text-sm font-medium text-primary mb-1.5 pl-1">Message</label>
                    <textarea 
                      rows={4} 
                      value={formData.message}
                      onChange={(e) => setFormData(prev => ({ ...prev, message: e.target.value }))}
                      className="w-full bg-white border border-gray-200 rounded-lg py-3 px-4 text-primary placeholder:text-gray-400 focus:ring-2 focus:ring-primary focus:border-primary sm:text-sm sm:leading-6 resize-none" 
                      placeholder="How can we help you?" 
                      required
                    ></textarea>
                </div>
                <button 
                    type="submit" 
                    disabled={loading}
                    className="w-full flex justify-center items-center gap-2 rounded-lg bg-primary px-3 py-4 text-sm font-bold leading-6 text-white shadow-lg hover:bg-primary/90 transition-colors disabled:opacity-70 disabled:cursor-not-allowed mt-2"
                >
                    {loading ? (
                        <>Sending...</>
                    ) : (
                        <>Send Message <span className="material-symbols-outlined text-[18px]">send</span></>
                    )}
                </button>
                </form>
            )}
         </div>
      </section>

      {/* Map Section - Google Maps Embed */}
      <section className="px-4 mb-12">
        <div className="w-full h-64 rounded-[2rem] overflow-hidden relative border border-black/5">
            <iframe
              src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3318.7!2d-117.8272!3d33.709!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x80dcdfe2e5f3b3f5%3A0x0!2s15771%20Red%20Hill%20Ave%20%23500%2C%20Tustin%2C%20CA%2092780!5e0!3m2!1sen!2sus!4v1702850000000!5m2!1sen!2sus"
              className="w-full h-full border-0"
              title="Ever House Location"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              allowFullScreen
            ></iframe>
            <div className="absolute bottom-4 left-0 right-0 flex justify-center gap-2">
                 <a 
                   href="https://maps.app.goo.gl/Zp93EMzyp9EA3vqA6" 
                   target="_blank" 
                   rel="noreferrer" 
                   className="bg-white text-primary px-4 py-2 rounded-lg shadow-md font-bold text-xs flex items-center gap-2 hover:shadow-lg transition-shadow"
                 >
                    <span className="material-symbols-outlined text-sm">map</span>
                    Open in Google Maps
                 </a>
                 <a 
                   href="https://maps.apple.com/?q=Even+House+Tustin+CA" 
                   target="_blank" 
                   rel="noreferrer" 
                   className="bg-zinc-700 text-white px-4 py-2 rounded-lg shadow-md font-bold text-xs flex items-center gap-2 hover:shadow-lg transition-shadow"
                 >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
                    </svg>
                    Apple Maps
                 </a>
            </div>
        </div>
      </section>

      <section className="px-4 py-8 mb-4">
        <div className="bg-[#293515] rounded-2xl p-6 text-center">
          <h3 className="text-xl font-bold text-white mb-2">Ready to become a member?</h3>
          <p className="text-white/70 text-sm mb-4">Join our community of golfers, creatives, and wellness enthusiasts.</p>
          <button 
            onClick={() => { startNavigation(); navigate('/membership'); }}
            className="bg-[#F2F2EC] text-[#293515] px-6 py-3 rounded-xl font-bold text-sm hover:bg-white transition-colors"
          >
            Apply for Membership
          </button>
        </div>
      </section>
      
      <Footer />
    </div>
    </AnimatedPage>
  );
};

const ContactCard: React.FC<{icon: string; title: string; value: string; href?: string}> = ({ icon, title, value, href }) => {
  const Wrapper = href ? 'a' : 'div';
  return (
    <Wrapper href={href} className="group flex items-center justify-between bg-white p-4 rounded-2xl border border-black/5 shadow-sm hover:shadow-md transition-all cursor-pointer">
       <div className="flex items-center gap-4">
            <div className="flex items-center justify-center size-12 rounded-full bg-[#F2F2EC] text-primary shrink-0">
                <span className="material-symbols-outlined text-[24px]">{icon}</span>
            </div>
            <div className="flex-1 min-w-0 text-left">
                <p className="text-[10px] font-bold text-primary/50 uppercase tracking-widest mb-0.5">{title}</p>
                <p className="text-primary font-bold truncate text-sm">{value}</p>
            </div>
       </div>
       <span className="material-symbols-outlined text-gray-300 group-hover:text-primary transition-colors">chevron_right</span>
    </Wrapper>
  );
};

export default Contact;