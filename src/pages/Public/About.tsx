import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import { usePageReady } from '../../contexts/PageReadyContext';
import { AnimatedPage } from '../../components/motion';
import SEO from '../../components/SEO';

const OFFERINGS = [
  { icon: 'sports_golf', title: 'Indoor Golf', description: 'State-of-the-art Trackman 4 simulators for practice, play, and entertainment. All skill levels welcome.' },
  { icon: 'work', title: 'Premium Workspace', description: 'Focused coworking spaces and bookable conference rooms for members who work differently.' },
  { icon: 'restaurant', title: 'Chef-Driven Café', description: 'Thoughtfully crafted food and beverages to fuel your day, from morning coffee to evening cocktails.' },
  { icon: 'celebration', title: 'Curated Events', description: 'From networking nights to golf tournaments, our events bring the community together.' },
  { icon: 'spa', title: 'Wellness', description: 'Wellness services and programming designed for the modern professional.' },
  { icon: 'meeting_room', title: 'Private Hire', description: 'Host your next corporate event, birthday, or team outing in our versatile spaces.' },
];

const VALUES = [
  { icon: 'groups', title: 'Community First', description: 'We believe the best things happen when great people come together.' },
  { icon: 'star', title: 'Quality Over Quantity', description: 'Every detail matters, from our simulators to our café menu.' },
  { icon: 'diversity_3', title: 'Inclusive Excellence', description: 'Whether you shoot a 70 or have never held a club, you belong here.' },
];

const About: React.FC = () => {
  const { setPageReady } = usePageReady();

  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

  return (
    <AnimatedPage>
      <SEO
        title="About Ever Club | Indoor Golf & Social Club in Tustin"
        description="Learn about Ever Club, Orange County's premier indoor golf & social club in Tustin. Trackman simulators, coworking, café, events & wellness."
        url="/about"
      />
      <div
        className="flex flex-col min-h-screen bg-bone dark:bg-[#141414] overflow-x-hidden"
        style={{ marginTop: 'calc(-1 * var(--header-offset))', paddingTop: 'var(--header-offset)' }}
      >
        <section className="px-6 pt-8 md:pt-12 pb-10 text-center animate-content-enter">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-primary dark:text-white mb-3" style={{ fontFamily: "'Newsreader', serif" }}>
            About Ever Club
          </h1>
          <p className="text-primary/70 dark:text-white/70 text-lg font-medium max-w-md mx-auto">
            Orange County's Premier Indoor Golf & Social Club
          </p>
        </section>

        <section className="px-6 pb-10 animate-content-enter-delay-1">
          <div className="max-w-2xl mx-auto">
            <h2 className="text-2xl font-bold text-primary dark:text-white mb-4" style={{ fontFamily: "'Newsreader', serif" }}>
              Our Story
            </h2>
            <div className="space-y-4 text-sm text-primary/70 dark:text-white/70 leading-relaxed">
              <p>
                Ever Club, formerly known as Even House, is a private members club located in Tustin, in the heart of Orange County, California. Founded to create a refined third space where ambitious professionals come together, the club offers an experience unlike any other in the region.
              </p>
              <p>
                We combine premium Trackman golf simulators with a professional workspace, a chef-driven café, and a calendar of curated social events — all under one roof. Whether you're perfecting your swing, closing a deal, or catching up with friends over craft cocktails, Ever Club is the place where work, play, and community converge.
              </p>
              <p>
                Our home at 15771 Red Hill Ave, Ste 500, Tustin, CA 92780 was designed from the ground up to serve the modern professional — someone who values quality, connection, and experiences that go beyond the ordinary.
              </p>
            </div>
          </div>
        </section>

        <section className="px-6 pb-10 animate-content-enter-delay-2">
          <div className="max-w-2xl mx-auto">
            <h2 className="text-2xl font-bold text-primary dark:text-white mb-6" style={{ fontFamily: "'Newsreader', serif" }}>
              What We Offer
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {OFFERINGS.map((item) => (
                <div
                  key={item.title}
                  className="bg-white dark:bg-[#1a1d15] rounded-2xl p-5 border border-black/5 dark:border-white/10 shadow-sm dark:shadow-black/20"
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div className="flex items-center justify-center size-10 rounded-full bg-bone dark:bg-white/5 text-primary dark:text-white shrink-0">
                      <span className="material-symbols-outlined text-xl">{item.icon}</span>
                    </div>
                    <h3 className="font-bold text-primary dark:text-white text-sm">{item.title}</h3>
                  </div>
                  <p className="text-xs text-primary/60 dark:text-white/60 leading-relaxed">{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="px-6 pb-10">
          <div className="max-w-2xl mx-auto">
            <h2 className="text-2xl font-bold text-primary dark:text-white mb-6" style={{ fontFamily: "'Newsreader', serif" }}>
              Our Values
            </h2>
            <div className="space-y-4">
              {VALUES.map((value) => (
                <div
                  key={value.title}
                  className="flex items-start gap-4 bg-[#E8E8E0]/50 dark:bg-white/5 rounded-2xl p-5"
                >
                  <div className="flex items-center justify-center size-10 rounded-full bg-primary/10 dark:bg-white/10 text-primary dark:text-white shrink-0 mt-0.5">
                    <span className="material-symbols-outlined text-xl">{value.icon}</span>
                  </div>
                  <div>
                    <h3 className="font-bold text-primary dark:text-white text-sm mb-1">{value.title}</h3>
                    <p className="text-xs text-primary/60 dark:text-white/60 leading-relaxed">{value.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="px-6 py-10 mb-4">
          <div className="bg-primary rounded-2xl p-8 text-center max-w-2xl mx-auto">
            <h2 className="text-2xl font-bold text-white mb-3" style={{ fontFamily: "'Newsreader', serif" }}>
              Ready to Experience Ever Club?
            </h2>
            <p className="text-white/70 text-sm mb-6 max-w-sm mx-auto">
              Discover what makes Ever Club Orange County's most talked-about private club. Book a tour or explore our membership options.
            </p>
            <div className="flex flex-col sm:flex-row justify-center gap-3">
              <Link
                to="/tours"
                className="inline-flex items-center justify-center gap-2 bg-[#F2F2EC] text-[#293515] px-6 py-3.5 rounded-xl font-bold text-sm hover:opacity-90 transition-opacity"
              >
                Book a Tour
                <span className="material-symbols-outlined text-lg">arrow_forward</span>
              </Link>
              <Link
                to="/membership"
                className="inline-flex items-center justify-center gap-2 border border-white/30 text-white px-6 py-3.5 rounded-xl font-bold text-sm hover:bg-white/10 transition-colors"
              >
                Explore Membership
              </Link>
            </div>
          </div>
        </section>

        <Footer />
      </div>
    </AnimatedPage>
  );
};

export default About;
