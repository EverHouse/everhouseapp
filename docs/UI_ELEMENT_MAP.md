# Ever Club App - Complete UI Element Map

This document maps every interactive UI element (buttons, links, cards, forms, modals) across the entire application.

---

## Table of Contents
1. [Public Pages](#public-pages)
2. [Member Portal](#member-portal)
3. [Admin/Staff Portal](#adminstaff-portal)
4. [Shared Components](#shared-components)
5. [Summary Statistics](#summary-statistics)

---

## Public Pages

### 1. Landing Page (`/`)

#### Hero Section
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Apply for Membership" | Link | Navigate | Goes to `/membership` |
| "Book a Tour" | Button | Opens modal | Opens HubSpotMeetingModal for tour scheduling |

#### Tour Booking Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| First Name | Text input | Form update | Updates form state |
| Last Name | Text input | Form update | Updates form state |
| Email | Email input | Form update | Updates form state |
| Phone | Tel input | Form update | Updates form state |
| "Continue to Select Time" | Button | Submit | POST `/api/tours/book`, shows calendar |
| "Done" | Button | Close | Closes modal after booking |

#### Membership Tiers Section
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Social Tier Card "View Details" | Link | Navigate | Goes to `/membership` |
| Core Tier Card "View Details" | Link | Navigate | Goes to `/membership` |
| Corporate Tier Card "View Details" | Link | Navigate | Goes to `/membership/corporate` |
| "Compare all tiers" | Link | Navigate | Goes to `/membership/compare` |

#### Private Events Section
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Inquire Now" | Link | Navigate | Goes to `/private-hire` |

---

### 2. Membership Page (`/membership`)

#### Overview Section
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Compare full feature table" | Link | Navigate | Goes to comparison page |

#### Membership Cards
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Social tier button | Button | Opens form | Opens HubSpotFormModal |
| Core tier button | Button | Opens form | Opens HubSpotFormModal |
| Premium tier button | Button | Opens form | Opens HubSpotFormModal |
| "View Details" (Corporate) | Button | Navigate | Goes to corporate page |

#### Day Passes Section
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Workspace" ($25/day) | Button | Select | Toggles workspace pass selection |
| "Golf Sim" ($50/60min) | Button | Select | Toggles sim pass selection |
| "Request a Pass" | Link | Navigate | Goes to `/contact` |

#### Application Modal (HubSpotFormModal)
| Element | Type | Action | Result |
|---------|------|--------|--------|
| First Name | Text input | Form update | Updates field |
| Last Name | Text input | Form update | Updates field |
| Email | Email input | Form update | Updates field |
| Phone | Tel input | Form update | Updates field |
| Tier Selection | Select dropdown | Form update | Updates selection |
| About You | Textarea | Form update | Updates field |
| "Submit Application" | Button | Submit | POST to HubSpot API |

---

### 3. Contact Page (`/contact`)

#### Contact Info Cards
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "VISIT US" | Card (static) | None | Displays address |
| "CALL US" | Link | Phone dialer | Opens `tel:9495455855` |
| "EMAIL US" | Link | Email client | Opens `mailto:info@everclub.club` |
| "MESSAGE US" | Link | External | Opens Apple Business Chat |

#### Contact Form
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Topic | Select | Form update | Membership/Private Events/General |
| Full Name | Text input | Form update | Updates name field |
| Email Address | Email input | Form update | Updates email field |
| Message | Textarea | Form update | Updates message field |
| "Send Message" | Button | Submit | POST `/api/hubspot/forms/contact` |
| "Send another message" | Button | Reset | Resets form for new submission |

#### Map Section
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Google Maps embed | iFrame | Interaction | Interactive map |
| "Open in Google Maps" | Link | External | Opens Google Maps |
| "Apple Maps" | Link | External | Opens Apple Maps |

---

### 4. Gallery Page (`/gallery`)

#### Filters
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "All" | Filter button | Filter | Shows all images |
| Category buttons | Filter buttons | Filter | Filters by category |

#### Gallery Grid
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Image thumbnail | Card | Opens viewer | Opens fullscreen image viewer |

#### Image Viewer Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Close (X) | Button | Close | Closes viewer |
| Left chevron | Button | Navigate | Shows previous image |
| Right chevron | Button | Navigate | Shows next image |
| Swipe gesture | Touch | Navigate | Swipes between images |
| Escape key | Keyboard | Close | Closes viewer |
| Arrow keys | Keyboard | Navigate | Navigates images |
| Background | Click | Close | Closes viewer |

---

### 5. What's On Page (`/whats-on`)

#### Filters
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "All" | Button | Filter | Shows all events/classes |
| "Events" | Button | Filter | Shows only events |
| "Wellness" | Button | Filter | Shows only wellness classes |

#### Event/Class Cards
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Card row | Accordion | Expand/collapse | Shows/hides details |
| "Get Tickets" | Link | External | Opens Eventbrite page |

#### CTA Section
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Explore Membership" | Button | Navigate | Goes to `/membership` |

---

### 6. Private Hire Page (`/private-hire`)

#### Inquiry Section
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Submit Inquiry" | Button | Opens form | Opens HubSpotFormModal |

#### Inquiry Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| First Name | Text input | Form update | Updates field |
| Last Name | Text input | Form update | Updates field |
| Email | Email input | Form update | Updates field |
| Phone | Tel input | Form update | Updates field |
| Company | Text input | Form update | Updates field |
| Event Details | Textarea | Form update | Updates field |
| "Submit Inquiry" | Button | Submit | POST to HubSpot |

---

### 7. Cafe Menu Page (`/menu`)

| Element | Type | Action | Result |
|---------|------|--------|--------|
| Category buttons | Filter buttons | Filter | Filters menu by category |
| Menu item row | Accordion | Expand/collapse | Shows item description |

---

### 8. FAQ Page (`/faq`)

| Element | Type | Action | Result |
|---------|------|--------|--------|
| "All" | Button | Filter | Shows all FAQs |
| Category buttons | Buttons | Filter | Filters FAQs by category |
| FAQ question | Accordion | Expand/collapse | Shows/hides answer |

---

### 9. Login Page (`/login`)

#### Initial Login Form
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Email input | Email input | Update + check | Updates email, checks if staff/admin |
| Password input | Password input | Update | Shown only for staff/admin with password |
| "Send Verification Code" | Button | Submit | POST `/api/auth/request-otp` |
| "Sign In" (password mode) | Button | Submit | POST `/api/auth/password-login` |
| "Use Verification Code Instead" | Button | Submit | Sends OTP as alternative |
| "Apply today" | Link | Navigate | Goes to `/membership` |

#### OTP Entry Screen
| Element | Type | Action | Result |
|---------|------|--------|--------|
| OTP digit inputs (x6) | Text inputs | Auto-advance | Fills code, auto-submits when complete |
| Paste handler | Clipboard | Fill | Fills multiple digits from clipboard |
| Auto-submit | Auto | Submit | POST `/api/auth/verify-otp` |
| "Resend code" | Button | Submit | Resends OTP email |
| "Use a different email" | Button | Reset | Returns to email entry |

---

## Member Portal

### 1. Dashboard (`/dashboard`)

#### Membership Card
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Membership card | Display | None | Shows tier, name, member since |

#### Quick Action Links
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Book a Simulator" | Link | Navigate | Goes to `/book` |
| "Browse Events" | Link | Navigate | Goes to `/member-events` |
| "Wellness Classes" | Link | Navigate | Goes to `/member-wellness` |
| "Check-In Guest" | Link | Opens modal | Opens guest check-in modal |

#### Upcoming Bookings
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Booking card | Card | Expand | Shows booking details |
| Swipe left | Gesture | Reschedule | Shows reschedule option |
| Swipe right | Gesture | Cancel | Shows cancel confirmation |
| Cancel button | Button | Cancel | POST `/api/bookings/{id}/member-cancel` |

#### Guest Check-In Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Guest name input | Text input | Update | Sets guest name |
| Submit button | Button | Submit | POST `/api/guests/checkin` |

---

### 2. Book Golf (`/book`)

#### Resource Tabs
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Simulator" tab | Tab button | Switch | Shows simulator booking |
| "Conference" tab | Tab button | Switch | Shows conference room booking |

#### Date Selection
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Date buttons | Button row | Select | Sets booking date |
| Calendar expand | Button | Expand | Shows full calendar picker |

#### Duration Selection
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "30m" / "60m" / "90m" / "120m" | Duration buttons | Select | Sets session duration |

#### Time Slots
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Time slot row | Accordion | Expand | Shows available bays |
| Bay card | Card | Select | Selects bay for booking |

#### Booking Request
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Guest count selector | +/- buttons | Adjust | Changes guest count |
| Notes input | Textarea | Update | Adds booking notes |
| "Request Booking" | Button | Submit | POST `/api/booking-requests` |

---

### 3. Events (`/member-events`)

#### Category Filter
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "All" | Filter chip | Filter | Shows all events |
| Category chips | Filter chips | Filter | Filters by category |

#### Event Cards
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Event card | Accordion | Expand | Shows full event details |
| "RSVP" | Button | Submit | POST `/api/rsvps` |
| "Cancel RSVP" | Button | Submit | DELETE `/api/rsvps/{id}/{email}` |
| "Add to Calendar" | Button | Download | Downloads .ics file |
| "Get Tickets" | Link | External | Opens Eventbrite |

---

### 4. Wellness (`/member-wellness`)

#### Tabs
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Classes" tab | Tab button | Switch | Shows wellness classes |
| "MedSpa" tab | Tab button | Switch | Shows MedSpa services |

#### Category Filter
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Category pills | Filter buttons | Filter | Filters classes by type |

#### Class Cards
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Class card | Accordion | Expand | Shows class details |
| "Sign Up" | Button | Submit | POST `/api/wellness-enrollments` |
| "Cancel" | Button | Submit | DELETE `/api/wellness-enrollments/{id}/{email}` |

#### MedSpa
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Book MedSpa" | Link | External | Opens external booking site |

---

### 5. Profile (`/profile`)

#### Settings Section
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Push notifications toggle | Toggle | Update | Toggles push notification subscription |

#### Password Section (Staff/Admin only)
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Current password | Password input | Update | Required for change |
| New password | Password input | Update | New password value |
| Confirm password | Password input | Update | Confirm new password |
| "Update Password" | Button | Submit | POST `/api/auth/set-password` |

#### Actions
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Report a Bug" | Button | Opens modal | Opens BugReportModal |
| "Sign Out" | Button | Logout | Clears session, redirects to `/` |

#### Guest Check-In Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Guest name | Text input | Update | Sets guest name |
| Check-In button | Button | Submit | Records guest check-in |

---

### 6. Updates (`/updates`)

#### Tabs
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Notifications" tab | Tab button | Switch | Shows notifications |
| "Announcements" tab | Tab button | Switch | Shows announcements |

#### Notifications List
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Mark All Read" | Button | Bulk update | PUT `/api/notifications/mark-read` |
| "Dismiss All" | Button | Bulk delete | DELETE `/api/notifications/dismiss-all` |
| Notification item | SwipeableListItem | Swipe left | Mark as read |
| Notification item | SwipeableListItem | Swipe right | Dismiss notification |

#### Announcements List
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Announcement card | Accordion | Expand | Shows full announcement |
| Action link | Link | Navigate/external | Goes to linked action |
| Dismiss button | Button | Dismiss | Dismisses announcement |

---

### 7. History (`/history`)

#### Tabs
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Bookings" tab | Tab button | Switch | Shows past bookings |
| "Experiences" tab | Tab button | Switch | Shows past events/classes |

#### Pull to Refresh
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Pull down | Gesture | Refresh | Reloads history data |

---

## Admin/Staff Portal

### Global Navigation

#### Header
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Ever Club Logo | Button | Navigate | Goes to home page `/` |
| Updates button | Button | Switch tab | Goes to Updates tab, shows badge |
| Profile avatar | Button | Navigate | Goes to `/profile` |

#### Bottom Navigation
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Home | Nav button | Switch tab | Home/Dashboard tab |
| Bookings | Nav button | Switch tab | Bookings tab (shows pending badge) |
| Tours | Nav button | Switch tab | Tours scheduling tab |
| Calendar | Nav button | Switch tab | Events/Wellness calendar |
| Notices | Nav button | Switch tab | Notices/Closures management |

---

### Home Tab (StaffCommandCenter)

#### Quick Actions
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Pending request cards | Card | Opens modal | Shows approve/decline options |
| "Approve" | Button | Opens modal | Opens Trackman confirmation |
| "Deny" | Button | Submit | PUT `/api/booking-requests/{id}` decline |
| Today's booking cards | Card | Opens details | View booking info |
| "Check-In" | Button | Submit | POST `/api/bookings/{id}/checkin` |

#### Navigation Cards
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Bookings | Card | Switch tab | Goes to Bookings tab |
| Calendar | Card | Switch tab | Goes to Events tab |
| Notices | Card | Switch tab | Goes to Notices tab |
| Updates | Card | Switch tab | Goes to Updates tab |
| Tours | Card | Switch tab | Goes to Tours tab |
| Inquiries | Card | Switch tab | Goes to Inquiries tab |
| Directory | Card | Switch tab | Goes to Member Directory |
| Team | Card | Switch tab | Goes to Staff Team tab |
| Training Guide | Card | Switch tab | Goes to Training Guide |
| Version History | Card | Switch tab | Goes to Changelog |
| Cafe Menu (Admin) | Card | Switch tab | Goes to Cafe Menu |
| Gallery (Admin) | Card | Switch tab | Goes to Gallery |
| FAQs (Admin) | Card | Switch tab | Goes to FAQ management |
| Manage Tiers (Admin) | Card | Switch tab | Goes to Membership Tiers |
| Bug Reports (Admin) | Card | Switch tab | Goes to Bug Reports |
| Trackman Import (Admin) | Card | Switch tab | Goes to Trackman CSV import |

---

### Bookings Tab

#### View Toggles
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Pending" | Tab | Filter | Show pending requests |
| "Scheduled" | Tab | Filter | Show approved/upcoming |
| "Calendar" | Tab | Filter | Show visual calendar |
| "Completed" | Tab | Filter | Show attended/no-show |
| "Cancellations" | Tab | Filter | Show cancelled/declined |

#### Pending View
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Request row | Click | Opens modal | View details with bay assignment |
| "Approve" | Button | Opens modal | Opens approval modal |
| "Decline" | Button | Opens modal | Opens decline modal |

#### Scheduled View
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Filter chips | Buttons | Filter | All/Today/Tomorrow/Week |
| Booking row | SwipeableListItem | Swipe | Reschedule/Cancel actions |
| Row tap | Tap | Opens modal | Opens booking detail |
| "Check-In" | Button | Opens modal | Opens attendance modal |

#### Manual Booking Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Member search | Search input | Search | Searches members |
| Member dropdown | Button list | Select | Selects member |
| Resource dropdown | Select | Choose | Selects bay/room |
| Date input | Date picker | Set | Sets booking date |
| Time dropdown | Select | Set | Sets start time |
| Duration dropdown | Select | Set | Sets duration |
| Guest count | Number input | Set | Sets guest count |
| Booking source | Select | Set | Sets source |
| Notes | Textarea | Update | Member-visible notes |
| Staff notes | Textarea | Update | Internal notes |
| "Create Booking" | Button | Submit | POST `/api/staff/bookings/manual` |

#### FAB
| Element | Type | Action | Result |
|---------|------|--------|--------|
| + button | FAB | Opens modal | Opens Manual Booking Modal |

---

### Events/Wellness Tab

#### Sub-tabs
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Events" | Tab | Switch | Show events management |
| "Wellness" | Tab | Switch | Show wellness classes |

#### Events Management
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Category chips | Buttons | Filter | Filter by category |
| Event card | Click | Opens modal | Opens edit modal |
| "RSVPs" | Button | Opens modal | GET `/api/events/{id}/rsvps` |
| "View" (Eventbrite) | Link | External | Opens Eventbrite page |
| "Delete" | Button | Delete | DELETE `/api/events/{id}` |

#### Event Edit Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Title | Text input | Update | Sets event title |
| Category | Select | Update | Sets category |
| Date/Time inputs | Pickers | Update | Sets date/time |
| Location | Text input | Update | Sets venue |
| Image URL | Text input | Update | Sets image |
| Max Attendees | Number | Update | Sets capacity |
| External Link | Text input | Update | Sets external URL |
| Description | Textarea | Update | Sets description |
| Visibility toggle | Buttons | Toggle | Public/Members only |
| "Save" | Button | Submit | POST/PUT `/api/events` |

#### FAB
| Element | Type | Action | Result |
|---------|------|--------|--------|
| + button | FAB | Opens modal | Opens Create Event Modal |

---

### Member Directory Tab

#### Search & Filter
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Search input | Text input | Filter | Filters by name/email |
| Tier filter chips | Buttons | Filter | Filters by tier |
| Tag filter chips | Buttons | Toggle | Filters by tags |

#### Member Row
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Member row | Click | Opens modal | Opens member details |

#### Member Details Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Email | Link | Email client | Opens mailto: |
| Phone | Link | Phone dialer | Opens tel: |
| "View as Member" | Button | Impersonate | View app as member |
| "Edit Tags" | Button | Opens editor | Manage member tags |
| Tag toggles | Buttons | Toggle | Add/remove tags |

---

### Tours Tab

#### Tour Cards
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Tour card | Display | None | Shows guest info, time, status |
| "Check In" (Today) | Button | Opens modal | Opens check-in modal |

#### Check-In Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Typeform embed | Embedded form | Fill | Collect guest info |
| "Mark as Checked In" | Button | Submit | POST `/api/tours/{id}/checkin` |

---

### Team Tab

#### Staff List
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Staff row | Click | Opens modal | Opens staff details |

#### Staff Details Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Edit" (Admin) | Button | Opens modal | Opens edit modal |
| "Delete" (Admin) | Button | Delete | DELETE `/api/staff-users/{id}` |

#### Edit Staff Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| First/Last Name | Text inputs | Update | Updates name |
| Email | Email input | Update | Updates email |
| Phone | Tel input | Update | Updates phone |
| Job Title | Text input | Update | Updates title |
| "Save" | Button | Submit | PUT `/api/staff-users/{id}` |

---

### Notices Tab

#### Notice Cards
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Notice card | Click | Opens modal | Opens edit modal |
| Active toggle | Toggle | Update | PUT `/api/closures/{id}` |
| Delete button | Button | Delete | DELETE `/api/closures/{id}` |

#### Notice Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Title | Text input | Update | Sets title |
| Reason | Textarea | Update | Sets reason |
| Start/End dates | Date pickers | Update | Sets date range |
| Start/End times | Time pickers | Update | Sets time range |
| Affected Areas | Select | Update | Sets areas |
| Block Type | Select | Update | Sets type |
| Notes | Textarea | Update | Sets notes |
| "Save Changes" | Button | Submit | PUT `/api/closures/{id}` |

#### FAB
| Element | Type | Action | Result |
|---------|------|--------|--------|
| + button | FAB | Opens modal | Opens Create Notice Modal |

---

### Cafe Menu Tab (Admin)

#### Category Filter
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Category chips | Buttons | Filter | Filter menu by category |

#### Menu Items
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Menu item row | Click | Opens modal | Opens edit modal |
| Delete button | Button | Delete | Deletes menu item |

#### Menu Item Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Name | Text input | Update | Sets item name |
| Price | Number input | Update | Sets price |
| Category | Select | Update | Sets category |
| Description | Textarea | Update | Sets description |
| Icon | Select | Update | Sets icon |
| Image upload | File input | Upload | POST `/api/admin/upload-image` |
| "Save" | Button | Submit | Add/update cafe item |

#### FAB
| Element | Type | Action | Result |
|---------|------|--------|--------|
| + button | FAB | Opens modal | Opens Create Item Modal |

---

### Gallery Tab (Admin)

#### Image List
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Image card | Click + Drag | Reorder | POST `/api/admin/gallery/reorder` |
| Active toggle | Toggle | Update | PUT `/api/admin/gallery/{id}` |
| Delete button | Button | Delete | DELETE `/api/admin/gallery/{id}` |

#### Image Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Title | Text input | Update | Sets title |
| File upload | File input | Upload | POST `/api/admin/upload-image` |
| Image URL | Text input | Update | Sets URL |
| Category | Select | Update | Sets category |
| Sort order | Number | Update | Sets order |
| Active toggle | Toggle | Update | Sets visibility |
| "Save" | Button | Submit | POST/PUT `/api/admin/gallery` |

#### FAB
| Element | Type | Action | Result |
|---------|------|--------|--------|
| + button | FAB | Opens modal | Opens Add Image Modal |

---

### FAQs Tab (Admin)

#### FAQ List
| Element | Type | Action | Result |
|---------|------|--------|--------|
| FAQ row | Click + Drag | Reorder | POST `/api/admin/faqs/reorder` |
| Active toggle | Toggle | Update | Toggle visibility |
| Delete button | Button | Delete | DELETE `/api/admin/faqs/{id}` |

#### FAQ Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Question | Text input | Update | Sets question |
| Answer | Textarea | Update | Sets answer |
| Category | Select | Update | Sets category |
| Sort order | Number | Update | Sets order |
| Active toggle | Toggle | Update | Sets visibility |
| "Save" | Button | Submit | POST/PUT `/api/admin/faqs` |

#### FAB
| Element | Type | Action | Result |
|---------|------|--------|--------|
| + button | FAB | Opens modal | Opens Create FAQ Modal |

---

### Tiers Tab (Admin Only)

#### Tier Cards
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Tier card | Click | Opens modal | Opens edit modal |

#### Tier Edit Modal (Full Screen)
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Name | Text input | Update | Sets tier name |
| Price String | Text input | Update | Sets display price |
| Description | Textarea | Update | Sets description |
| Button Text | Text input | Update | Sets CTA text |
| Show in Comparison | Toggle | Update | Toggle table visibility |
| Daily Sim Minutes | Number | Update | Sets sim limit |
| Guest Passes/Month | Number | Update | Sets guest passes |
| Booking Window Days | Number | Update | Sets advance booking |
| Daily Conf Room Minutes | Number | Update | Sets conf room limit |
| Permission toggles | Toggle grid | Update | Sets permissions |
| Feature checkboxes | Checkbox grid | Update | Sets features |
| Add Feature | Text + Button | Add | Adds new feature |
| Remove Feature | Button | Remove | Removes feature |
| Highlight toggle | Toggle | Update | Marks highlighted (max 4) |
| "Save" | Button | Submit | PUT/POST `/api/membership-tiers` |

#### FAB
| Element | Type | Action | Result |
|---------|------|--------|--------|
| + button | FAB | Opens modal | Opens Create Tier Modal |

---

### Inquiries Tab

#### Status Filters
| Element | Type | Action | Result |
|---------|------|--------|--------|
| All/New/Read/Replied/Archived | Tabs | Filter | Filter by status |

#### Form Type Filter
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Type chips | Buttons | Filter | Filter by form type |

#### Inquiry Row
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Inquiry row | Click | Opens modal | Opens detail, marks read |

#### Inquiry Detail Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Email | Link | Email client | Opens mailto: |
| Phone | Link | Phone dialer | Opens tel: |
| Status buttons | Buttons | Update | PUT `/api/admin/inquiries/{id}` |
| Staff notes | Textarea | Update | Internal notes |
| "Save Notes" | Button | Submit | PUT `/api/admin/inquiries/{id}` |
| Archive | Button | Archive | DELETE with archive flag |

---

### Bug Reports Tab (Admin Only)

#### Status Filters
| Element | Type | Action | Result |
|---------|------|--------|--------|
| All/Open/In Progress/Resolved | Tabs | Filter | Filter by status |

#### Bug Report Row
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Report row | Click | Opens modal | Opens detail modal |

#### Bug Report Detail Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Screenshot | Image | View | Shows bug screenshot |
| Status buttons | Buttons | Update | PUT `/api/admin/bug-reports/{id}` |
| Staff notes | Textarea | Update | Resolution notes |
| "Save Notes" | Button | Submit | PUT `/api/admin/bug-reports/{id}` |
| "Delete" | Button | Delete | DELETE `/api/admin/bug-reports/{id}` |

---

### Trackman Import Tab (Admin Only)

#### CSV Upload
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Drag-and-drop zone | Drop zone | Upload | POST `/api/admin/trackman/upload` |
| Click to browse | Click | File picker | Opens file dialog |

#### Unmatched Bookings
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Resolve" | Button | Opens modal | Opens resolve modal |

#### Resolve Modal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Member search | Text input | Search | Search for member |
| Member selection | Button list | Select | Select member to assign |
| "Confirm Resolution" | Button | Submit | PUT `/api/admin/trackman/unmatched/{id}/resolve` |

---

## Shared Components

### MemberBottomNav
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Home | Nav button | Navigate | Goes to `/dashboard` |
| Book | Nav button | Navigate | Goes to `/book` |
| Wellness | Nav button | Navigate | Goes to `/member-wellness` |
| Events | Nav button | Navigate | Goes to `/member-events` |
| History | Nav button | Navigate | Goes to `/history` |

### MenuOverlay
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Backdrop | Click | Close | Closes overlay |
| Close (X) | Button | Close | Closes overlay |
| Logo | Click | Navigate | Goes to home |
| "Home" | Link | Navigate | Goes to `/` |
| "Membership" | Link | Navigate | Goes to `/membership` |
| "What's On" | Link | Navigate | Goes to `/whats-on` |
| "Private Hire" | Link | Navigate | Goes to `/private-hire` |
| "Menu" | Link | Navigate | Goes to `/menu` |
| "Gallery" | Link | Navigate | Goes to `/gallery` |
| "Contact" | Link | Navigate | Goes to `/contact` |

### Footer
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Phone number | Link | Phone dialer | Opens tel: |
| Instagram | Link | External | Opens Instagram |
| Facebook | Link | External | Opens Facebook |
| LinkedIn | Link | External | Opens LinkedIn |
| Website | Link | External | Opens website |

### BugReportModal
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Description | Textarea | Update | Sets bug description |
| Screenshot upload | Button | Upload | Uploads screenshot |
| Remove screenshot | Button | Remove | Removes attached image |
| "Submit Bug Report" | Button | Submit | POST `/api/admin/bug-reports` |
| "Done" | Button | Close | Closes modal after success |

### Toast
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Dismiss (X) | Button | Dismiss | Removes toast |
| Auto-dismiss | Timer | Dismiss | Auto-removes after timeout |

### ModalShell
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Backdrop | Click | Close | Closes modal |
| Close (X) | Button | Close | Closes modal |
| Escape key | Keyboard | Close | Closes modal |

### SwipeableListItem
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Swipe left | Gesture | Action | Triggers left action |
| Swipe right | Gesture | Action | Triggers right action |
| Left action button | Button | Action | Executes left action |
| Right action button | Button | Action | Executes right action |
| Tap elsewhere | Tap | Close | Closes swipe actions |

### PullToRefresh
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Pull down | Touch gesture | Refresh | Triggers onRefresh callback |
| Release | Touch release | Complete | Completes refresh animation |

### ViewAsBanner
| Element | Type | Action | Result |
|---------|------|--------|--------|
| "Exit" | Button | Exit view | Clears view-as, goes to directory |

### AnnouncementAlert
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Card | Click | Expand/action | Opens announcement or triggers action |
| Dismiss (X) | Button | Dismiss | Dismisses announcement |
| Enter/Space | Keyboard | Activate | Activates card action |

### ClosureAlert
| Element | Type | Action | Result |
|---------|------|--------|--------|
| Card | Click | Expand | Shows closure details |
| Dismiss (X) | Button | Dismiss | Dismisses alert |
| Enter/Space | Keyboard | Activate | Activates card action |

---

## Summary Statistics

### By Area
| Area | Interactive Elements |
|------|---------------------|
| Public Pages | ~83 elements |
| Member Portal | ~85 elements |
| Admin/Staff Portal | ~400+ elements |
| Shared Components | ~69 elements |
| **Total** | **~637+ interactive elements** |

### By Type
| Element Type | Count |
|--------------|-------|
| Buttons | ~250 |
| Links | ~60 |
| Form inputs | ~120 |
| Modals | ~35 unique modals |
| Accordions | ~25 |
| Toggles | ~30 |
| Swipe gestures | ~15 |
| Drag actions | ~8 |

### API Endpoints Triggered
| Category | Count |
|----------|-------|
| GET endpoints | ~45 |
| POST endpoints | ~35 |
| PUT endpoints | ~25 |
| DELETE endpoints | ~15 |
| External (HubSpot, Eventbrite) | ~8 |
| **Total** | **~128 distinct API calls** |

---

*Last updated: January 2026*
