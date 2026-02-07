import type { CafeItem, EventData, Announcement, MemberProfile, Booking } from '../types/data';

export const INITIAL_CAFE: CafeItem[] = [
  // COFFEE
  { id: 'esp', category: "Coffee", name: "Espresso", price: 3, desc: "", icon: "coffee", image: "/images/cafe-bar-optimized.webp" },
  { id: 'drp', category: "Coffee", name: "Drip", price: 4, desc: "", icon: "coffee_maker", image: "/images/cafe-bar-optimized.webp" },
  { id: 'ame', category: "Coffee", name: "Americano", price: 4, desc: "", icon: "local_cafe", image: "/images/cafe-bar-optimized.webp" },
  { id: 'cap', category: "Coffee", name: "Cappuccino", price: 4, desc: "", icon: "coffee", image: "/images/cafe-bar-optimized.webp" },
  { id: 'flt', category: "Coffee", name: "Flat White", price: 4, desc: "", icon: "local_cafe", image: "/images/cafe-bar-optimized.webp" },
  { id: 'cor', category: "Coffee", name: "Cortado", price: 4, desc: "", icon: "local_cafe", image: "/images/cafe-bar-optimized.webp" },
  { id: 'flb', category: "Coffee", name: "Flash Brew", price: 5, desc: "Iced | Hot", icon: "ac_unit", image: "/images/cafe-bar-optimized.webp" },
  { id: 'lat', category: "Coffee", name: "Latte", price: 5, desc: "Rotating specialty roasts", icon: "local_cafe", image: "/images/cafe-bar-optimized.webp" },
  { id: 'pov', category: "Coffee", name: "Pour Over", price: 0, desc: "Lightly sweetened cold foam | Iced coffee or matcha", icon: "water_drop", image: "/images/cafe-bar-optimized.webp" },
  { id: 'tea', category: "Coffee", name: "Leaves and Flowers Tea", price: 5, desc: "Ichibana | Tropic Garden | Mountain Beauty", icon: "emoji_food_beverage", image: "/images/cafe-bar-optimized.webp" },
  { id: 'mat', category: "Coffee", name: "Nekohama Matcha", price: 8, desc: "Organic A1 pinnacle ceremonial grade", icon: "tea_bag", image: "/images/cafe-bar-optimized.webp" },
  { id: 'pit', category: "Coffee", name: "Pit Stop", price: 7, desc: "Seasonal cherry pie latte w/ graham cracker dust", icon: "pie_chart", image: "/images/cafe-bar-optimized.webp" },
  { id: 'sea', category: "Coffee", name: "Seasonal Tonic", price: 7, desc: "Pear-ginger | Served with espresso or matcha", icon: "spa", image: "/images/cafe-bar-optimized.webp" },
  { id: 'pec', category: "Coffee", name: "Pecan Prix", price: 8, desc: "Pecan pie matcha latte w/ maple creamtop", icon: "icecream", image: "/images/cafe-bar-optimized.webp" },
  { id: 'nik', category: "Coffee", name: "Niko No. 3", price: 5, desc: "Espresso over grass-fed cinnamon honey butter", icon: "cookie", image: "/images/cafe-bar-optimized.webp" },

  // BREAKFAST
  { id: 'egg_t', category: "Breakfast", name: "Egg Toast", price: 14, desc: "Schaner Farm scrambled eggs, whipped ricotta, chives, micro greens", icon: "bakery_dining", image: "/images/cafe-bar-optimized.webp" },
  { id: 'avo', category: "Breakfast", name: "Avocado Toast", price: 16, desc: "Hass smashed avocado, radish, lemon, micro greens, dill", icon: "nutrition", image: "/images/cafe-bar-optimized.webp" },
  { id: 'ban', category: "Breakfast", name: "Banana & Honey Toast", price: 14, desc: "Banana, whipped ricotta, Hapa Honey Farm local honey", icon: "breakfast_dining", image: "/images/cafe-bar-optimized.webp" },
  { id: 'smk_t', category: "Breakfast", name: "Smoked Salmon Toast", price: 20, desc: "Alaskan king smoked salmon, whipped cream cheese, dill, capers", icon: "set_meal", image: "/images/cafe-bar-optimized.webp" },
  { id: 'cro', category: "Breakfast", name: "Breakfast Croissant", price: 16, desc: "Schaner Farm eggs, New School american cheese", icon: "bakery_dining", image: "/images/cafe-bar-optimized.webp" },
  { id: 'oml', category: "Breakfast", name: "French Omelette", price: 14, desc: "Schaner Farm eggs, cultured butter, fresh herbs", icon: "egg_alt", image: "/images/cafe-bar-optimized.webp" },
  { id: 'stk', category: "Breakfast", name: "Hanger Steak & Eggs", price: 24, desc: "Autonomy Farms Hanger steak, Schaner Farm eggs", icon: "restaurant", image: "/images/cafe-bar-optimized.webp" },
  { id: 'bac', category: "Breakfast", name: "Bacon & Eggs", price: 14, desc: "Applewood smoked bacon, Schaner Farm eggs", icon: "bento", image: "/images/cafe-bar-optimized.webp" },
  { id: 'yog', category: "Breakfast", name: "Yogurt Parfait", price: 14, desc: "Yogurt, seasonal fruits, farmstead granola, Hapa Honey", icon: "icecream", image: "/images/cafe-bar-optimized.webp" },

  // LUNCH
  { id: 'cae', category: "Lunch", name: "Caesar Salad", price: 15, desc: "Romaine lettuce, homemade dressing, grated Reggiano", icon: "dinner_dining", image: "/images/cafe-bar-optimized.webp" },
  { id: 'wed', category: "Lunch", name: "Wedge Salad", price: 16, desc: "Iceberg lettuce, bacon, red onion, cherry tomatoes, bleu cheese", icon: "kebab_dining", image: "/images/cafe-bar-optimized.webp" },
  { id: 'chk', category: "Lunch", name: "Chicken Salad Sandwich", price: 14, desc: "Autonomy Farms chicken, celery, toasted pan loaf", icon: "lunch_dining", image: "/images/cafe-bar-optimized.webp" },
  { id: 'tun', category: "Lunch", name: "Tuna Salad Sandwich", price: 14, desc: "Wild pole-caught albacore tuna, sprouts, chimichurri", icon: "set_meal", image: "/images/cafe-bar-optimized.webp" },
  { id: 'grl', category: "Lunch", name: "Grilled Cheese", price: 12, desc: "New School american cheese, brioche pan loaf", icon: "fastfood", image: "/images/cafe-bar-optimized.webp" },
  { id: 'blt', category: "Lunch", name: "Heirloom BLT", price: 18, desc: "Applewood smoked bacon, butter lettuce, heirloom tomatoes", icon: "lunch_dining", image: "/images/cafe-bar-optimized.webp" },
  { id: 'bra', category: "Lunch", name: "Bratwurst", price: 12, desc: "German bratwurst, sautéed onions & peppers, toasted brioche", icon: "kebab_dining", image: "/images/cafe-bar-optimized.webp" },
  { id: 'bis', category: "Lunch", name: "Bison Serrano Chili", price: 14, desc: "Pasture raised bison, serrano, anaheim, cheddar cheese", icon: "soup_kitchen", image: "/images/cafe-bar-optimized.webp" },

  // SIDES
  { id: 's_bac', category: "Sides", name: "Bacon (2 slices)", price: 6, desc: "", icon: "bento", image: "/images/cafe-bar-optimized.webp" },
  { id: 's_egg', category: "Sides", name: "Eggs, Scrambled", price: 8, desc: "", icon: "egg_alt", image: "/images/cafe-bar-optimized.webp" },
  { id: 's_fru', category: "Sides", name: "Seasonal Fruit Bowl", price: 10, desc: "", icon: "nutrition", image: "/images/cafe-bar-optimized.webp" },
  { id: 's_smk', category: "Sides", name: "Smoked Salmon", price: 9, desc: "", icon: "set_meal", image: "/images/cafe-bar-optimized.webp" },
  { id: 's_tst', category: "Sides", name: "Toast (2 slices)", price: 3, desc: "", icon: "breakfast_dining", image: "/images/cafe-bar-optimized.webp" },
  { id: 's_jam', category: "Sides", name: "Sqirl Seasonal Jam", price: 3, desc: "", icon: "kitchen", image: "" },
  { id: 's_pis', category: "Sides", name: "Pistakio Spread", price: 4, desc: "", icon: "cookie", image: "" },

  // KIDS
  { id: 'k_grl', category: "Kids", name: "Grilled Cheese", price: 6, desc: "", icon: "fastfood", image: "" },
  { id: 'k_dog', category: "Kids", name: "Hot Dog", price: 8, desc: "", icon: "kebab_dining", image: "" },

  // DESSERT
  { id: 'gel', category: "Dessert", name: "Gelato Sandwiches", price: 6, desc: "Vanilla bean w/ choc chip OR Sea salt caramel w/ snickerdoodle", icon: "icecream", image: "/images/cafe-bar-optimized.webp" },
  { id: 'pie', category: "Dessert", name: "Seasonal Pie, Slice", price: 6, desc: "With house made creme", icon: "pie_chart", image: "/images/cafe-bar-optimized.webp" },

  // SHAREABLES
  { id: 'clu', category: "Shareables", name: "Club Charcuterie", price: 32, desc: "", icon: "tapas", image: "/images/cafe-bar-optimized.webp" },
  { id: 'chi', category: "Shareables", name: "Chips & Salsa", price: 10, desc: "", icon: "tapas", image: "/images/cafe-bar-optimized.webp" },
  { id: 'cav', category: "Shareables", name: "Caviar Service", price: 0, desc: "", icon: "blur_circular", image: "/images/cafe-bar-optimized.webp" },
  { id: 'tin', category: "Shareables", name: "Tinned Fish Tray", price: 47, desc: "", icon: "sardine", image: "/images/cafe-bar-optimized.webp" },
];

export const INITIAL_EVENTS: EventData[] = [
  {
    id: '1',
    source: 'internal',
    title: 'House Collectives: Chez Doc',
    category: 'Social',
    date: 'Fri, 20 Jan',
    time: '11:00 PM',
    location: 'Barcelona Club',
    image: '/images/events-crowd-optimized.webp',
    description: 'Join us for a special edition of House Collectives.',
    attendees: [],
    capacity: 50,
    ticketsSold: 42
  },
  {
    id: '2',
    source: 'internal',
    title: 'Brunch & Cocktails',
    category: 'Dining',
    date: 'Sat, 21 Jan',
    time: '1:00 PM',
    location: 'Soho House Barcelona',
    image: '/images/cafe-bar-optimized.webp',
    description: 'A curated brunch menu paired with signature botanical cocktails.',
    attendees: [],
    capacity: 30,
    ticketsSold: 12
  },
  {
    id: 'eb-101',
    source: 'eventbrite',
    externalLink: 'https://www.eventbrite.com',
    title: 'Tustin Art Walk (Public)',
    category: 'Social',
    date: 'Sun, 22 Jan',
    time: '10:00 AM',
    location: 'Old Town Tustin',
    image: '/images/venue-wide-optimized.webp',
    description: 'Join the community for a guided walk through local galleries. Tickets handled via Eventbrite.',
    attendees: [],
    capacity: 100,
    ticketsSold: 85
  }
];

export const INITIAL_ANNOUNCEMENTS: Announcement[] = [];

export const INITIAL_MEMBERS: MemberProfile[] = [
  { 
    id: '8821', 
    name: "Alexander James", 
    tier: "Core", 
    isFounding: true,
    status: "Active", 
    email: "alex@example.com", 
    phone: "+1 (949) 555-0101",
    joinDate: "Jan 2021", 
    avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuCfn5ddkAImjBeYIVGDC9eu6eVBy4VdxiMZcgL75jHdPGbriX1aGdJ5m2yagDgcPzq3dACO0xbgNxwfcG_j7f5rROEXbwGGTeqNRmAWD2vHkgY3JlItOfHUfgl3AcPUTZEqjxIFGt-zeP1Sf2r4YV9pchyafGGtpEaTBzfRHKZqzSudHdTUCdv2cK3fDpxYwcLaBeOvl6JhLuXfwLhz3sbhnDq188os16jhbKV6lfdMELIZ-W0XYNC9sWvU-NllhtC7X7JzcBQYv39_" 
  },
  { 
    id: '8822', 
    name: "Sarah Connor", 
    tier: "Core", 
    isFounding: false,
    status: "Active", 
    email: "sarah@example.com", 
    phone: "+1 (949) 555-0102",
    joinDate: "Mar 2022", 
    avatar: "https://i.pravatar.cc/300?img=5" 
  },
  { 
    id: '8823', 
    name: "James Bond", 
    tier: "Premium", 
    isFounding: false,
    status: "Active", 
    email: "jb@example.com", 
    phone: "+1 (949) 555-0007",
    joinDate: "Dec 2023", 
    avatar: "https://i.pravatar.cc/300?img=8" 
  },
  { 
    id: '8824', 
    name: "Ellen Ripley", 
    tier: "Social", 
    isFounding: false,
    status: "Pending", 
    email: "ellen@example.com", 
    phone: "+1 (949) 555-0104",
    joinDate: "Pending", 
    avatar: "https://i.pravatar.cc/300?img=9" 
  },
  { 
    id: 'stf-1', 
    name: "Adam Admin", 
    tier: "Management", 
    status: "Active", 
    email: "adam@everclub.app", 
    phone: "+1 (949) 555-9999",
    role: 'admin', 
    joinDate: "Jan 2020",
    avatar: "https://i.pravatar.cc/300?img=11"
  },
  { 
    id: 'stf-2', 
    name: "Nick Staff", 
    tier: "Concierge", 
    status: "Active", 
    email: "nick@everclub.app", 
    phone: "+1 (949) 555-8888",
    role: 'admin',
    joinDate: "Mar 2021",
    avatar: "https://i.pravatar.cc/300?img=12"
  },
];

export const INITIAL_BOOKINGS: Booking[] = [
  { id: 'b1', type: 'dining', title: 'Lunch at The Patio', date: 'Tue, Oct 24', time: '12:30 PM', details: '4 Guests', color: 'accent' },
  { id: 'b2', type: 'golf', title: 'Golf Simulator Bay 2', date: 'Wed, Oct 25', time: '09:00 AM', details: '60 min', color: 'primary' }
];
