import React from 'react';
import { SlideUpDrawer } from '../../../SlideUpDrawer';
import IdScannerModal from '../../../staff-command-center/modals/IdScannerModal';
import RedeemDayPassSection from '../RedeemPassCard';
import POSProductGrid from './POSProductGrid';
import POSCart from './POSCart';
import POSCustomerSection from './POSCustomerSection';
import POSCheckoutDrawer from './POSCheckoutDrawer';
import { usePOSRegister } from './usePOSRegister';
import { CATEGORY_TABS } from './posTypes';

const POSRegister: React.FC = () => {
  const pos = usePOSRegister();

  const renderMobileCartDrawerContent = () => (
    <div className="space-y-4 px-5 pb-5">
      <POSCart
        cartItems={pos.cartItems}
        updateQuantity={pos.updateQuantity}
        clearCart={pos.clearCart}
      />

      {pos.cartItems.length > 0 && (
        <>
          <div>
            <label className="block text-sm font-medium text-primary dark:text-white mb-1.5">
              Description (optional)
            </label>
            <input
              type="text"
              value={pos.description}
              onChange={(e) => pos.setDescription(e.target.value)}
              placeholder="Add a note..."
              className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="text-center">
            <p className="text-3xl font-bold text-primary dark:text-white">{pos.totalFormatted}</p>
          </div>

          <button
            onClick={() => {
              pos.setMobileCartOpen(false);
              pos.setDrawerOpen(true);
            }}
            disabled={!pos.canReview}
            className="w-full py-4 rounded-xl font-semibold bg-primary dark:bg-lavender text-white transition-all duration-fast flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined">shopping_cart_checkout</span>
            Review & Charge
          </button>
        </>
      )}
    </div>
  );

  const drawerContent = (
    <POSCheckoutDrawer
      isDark={pos.isDark}
      success={pos.success}
      useGuestCheckout={pos.useGuestCheckout}
      useNewCustomer={pos.useNewCustomer}
      cartItems={pos.cartItems}
      totalFormatted={pos.totalFormatted}
      totalCents={pos.totalCents}
      error={pos.error}
      setError={pos.setError}
      receiptSent={pos.receiptSent}
      receiptSending={pos.receiptSending}
      guestReceiptEmail={pos.guestReceiptEmail}
      setGuestReceiptEmail={pos.setGuestReceiptEmail}
      attachingEmail={pos.attachingEmail}
      selectedPaymentMethod={pos.selectedPaymentMethod}
      handleSelectPaymentMethod={pos.handleSelectPaymentMethod}
      savedCard={pos.savedCard}
      checkingSavedCard={pos.checkingSavedCard}
      clientSecret={pos.clientSecret}
      stripePromise={pos.stripePromise}
      isCreatingIntent={pos.isCreatingIntent}
      isProcessing={pos.isProcessing}
      handleCardPaymentSuccess={pos.handleCardPaymentSuccess}
      handleTerminalSuccess={pos.handleTerminalSuccess}
      handleSavedCardCharge={pos.handleSavedCardCharge}
      handleSendReceipt={pos.handleSendReceipt}
      handleGuestReceiptSubmit={pos.handleGuestReceiptSubmit}
      resetForm={pos.resetForm}
      getCustomerInfo={pos.getCustomerInfo}
      buildDescription={pos.buildDescription}
    />
  );

  const customerSection = (
    <POSCustomerSection
      useGuestCheckout={pos.useGuestCheckout}
      setUseGuestCheckout={pos.setUseGuestCheckout}
      useNewCustomer={pos.useNewCustomer}
      setUseNewCustomer={pos.setUseNewCustomer}
      selectedMember={pos.selectedMember}
      setSelectedMember={pos.setSelectedMember}
      newCustomerFirstName={pos.newCustomerFirstName}
      setNewCustomerFirstName={pos.setNewCustomerFirstName}
      newCustomerLastName={pos.newCustomerLastName}
      setNewCustomerLastName={pos.setNewCustomerLastName}
      newCustomerEmail={pos.newCustomerEmail}
      setNewCustomerEmail={pos.setNewCustomerEmail}
      newCustomerPhone={pos.newCustomerPhone}
      setNewCustomerPhone={pos.setNewCustomerPhone}
      scannedIdImage={pos.scannedIdImage}
      setScannedIdImage={pos.setScannedIdImage}
      setSavedCard={pos.setSavedCard}
      setShowIdScanner={pos.setShowIdScanner}
    />
  );

  const productGrid = (
    <POSProductGrid
      activeTab={pos.activeTab}
      isMobile={pos.isMobile}
      passProducts={pos.passProducts}
      passProductsLoading={pos.passProductsLoading}
      cafeLoading={pos.cafeLoading}
      sortedCafeCategories={pos.sortedCafeCategories}
      groupedCafeItems={pos.groupedCafeItems}
      addedProductId={pos.addedProductId}
      addToCart={pos.addToCart}
    />
  );

  const categoryTabs = (
    <div className={`flex gap-2 ${pos.isMobile ? 'mb-4 overflow-x-auto pb-1 scrollbar-hide' : 'mb-4 flex-wrap'}`}>
      {CATEGORY_TABS.map(tab => (
        <button
          key={tab.key}
          onClick={() => pos.setActiveTab(tab.key)}
          className={`${pos.isMobile ? 'shrink-0' : ''} flex items-center gap-1.5 ${pos.isMobile ? 'px-3 py-1.5' : 'px-4 py-2'} rounded-full text-sm font-medium ${pos.isMobile ? 'whitespace-nowrap' : ''} transition-colors ${
            pos.activeTab === tab.key
              ? 'bg-primary dark:bg-lavender text-white'
              : 'bg-white/60 dark:bg-white/10 text-primary/60 dark:text-white/60 hover:bg-white/80 dark:hover:bg-white/15'
          }`}
        >
          <span className="material-symbols-outlined text-base">{tab.icon}</span>
          {tab.label}
        </button>
      ))}
    </div>
  );

  if (pos.isMobile) {
    return (
      <div className="pb-24">
        <div className="space-y-4">
          <div className="bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl p-4 shadow-liquid dark:shadow-liquid-dark overflow-visible relative z-20">
            {customerSection}
          </div>

          <div className="bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl p-4 shadow-liquid dark:shadow-liquid-dark">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-primary dark:text-accent">grid_view</span>
              <h3 className="font-bold text-primary dark:text-white">Products</h3>
            </div>
            {categoryTabs}
            {productGrid}
          </div>

          <RedeemDayPassSection variant="card" />
        </div>

        {(pos.cartItems.length > 0 || pos.canReview) && (
          <div className="fixed bottom-0 left-0 right-0 z-50 bg-white/80 dark:bg-[#1a1d12]/90 backdrop-blur-xl border-t border-primary/10 dark:border-white/10 px-4 py-3 safe-area-bottom">
            <div className="flex items-center gap-3">
              <button
                onClick={() => pos.setMobileCartOpen(true)}
                className="relative p-2"
              >
                <span className="material-symbols-outlined text-2xl text-primary dark:text-white">shopping_cart</span>
                {pos.totalItems > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-5 h-5 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center">
                    {pos.totalItems}
                  </span>
                )}
              </button>

              <div className="flex-1">
                <p className="text-lg font-bold text-primary dark:text-white">{pos.totalFormatted}</p>
              </div>

              <button
                onClick={() => {
                  if (pos.canReview) {
                    pos.setDrawerOpen(true);
                  } else {
                    pos.setMobileCartOpen(true);
                  }
                }}
                disabled={pos.cartItems.length === 0}
                className="px-6 py-3 rounded-xl font-semibold bg-primary dark:bg-lavender text-white transition-all duration-fast flex items-center gap-2 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined text-lg">shopping_cart_checkout</span>
                Review
              </button>
            </div>
          </div>
        )}

        <SlideUpDrawer
          isOpen={pos.mobileCartOpen}
          onClose={() => pos.setMobileCartOpen(false)}
          title="Your Cart"
          maxHeight="large"
        >
          {renderMobileCartDrawerContent()}
        </SlideUpDrawer>

        <SlideUpDrawer
          isOpen={pos.drawerOpen}
          onClose={() => {
            if (!pos.success) {
              pos.setDrawerOpen(false);
              pos.setSelectedPaymentMethod(null);
              pos.setClientSecret(null);
              pos.setPaymentIntentId(null);
              pos.setError(null);
            }
          }}
          title="Review & Charge"
          maxHeight="large"
          dismissible={!pos.success && !pos.isProcessing && !pos.isCreatingIntent}
        >
          {drawerContent}
        </SlideUpDrawer>
      </div>
    );
  }

  return (
    <div className="flex gap-6 items-start">
      <div className="flex-[2] min-w-0">
        <div className="bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl p-5 shadow-liquid dark:shadow-liquid-dark">
          <div className="flex items-center gap-2 mb-4">
            <span className="material-symbols-outlined text-primary dark:text-accent">grid_view</span>
            <h3 className="font-bold text-primary dark:text-white text-lg">Products</h3>
          </div>
          {categoryTabs}
          {productGrid}
        </div>
      </div>

      <div className="flex-1 min-w-[320px] max-w-[400px] sticky top-4">
        <div className="bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl p-5 shadow-liquid dark:shadow-liquid-dark space-y-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary dark:text-accent">point_of_sale</span>
            <h3 className="font-bold text-primary dark:text-white">Checkout</h3>
          </div>

          {customerSection}

          <div className={`border-t ${pos.isDark ? 'border-white/10' : 'border-primary/10'}`} />

          <POSCart
            cartItems={pos.cartItems}
            updateQuantity={pos.updateQuantity}
            clearCart={pos.clearCart}
          />

          {pos.cartItems.length > 0 && (
            <>
              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-1.5">
                  Description (optional)
                </label>
                <input
                  type="text"
                  value={pos.description}
                  onChange={(e) => pos.setDescription(e.target.value)}
                  placeholder="Add a note..."
                  className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              <div className="text-center">
                <p className="text-3xl font-bold text-primary dark:text-white">{pos.totalFormatted}</p>
              </div>
            </>
          )}

          <button
            onClick={() => pos.setDrawerOpen(true)}
            disabled={!pos.canReview}
            className="w-full py-4 rounded-xl font-semibold bg-primary dark:bg-lavender text-white transition-all duration-fast flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined">shopping_cart_checkout</span>
            Review & Charge
          </button>
        </div>

        <div className="mt-4">
          <RedeemDayPassSection variant="card" />
        </div>
      </div>

      <SlideUpDrawer
        isOpen={pos.drawerOpen}
        onClose={() => {
          if (!pos.success) {
            pos.setDrawerOpen(false);
            pos.setSelectedPaymentMethod(null);
            pos.setClientSecret(null);
            pos.setPaymentIntentId(null);
            pos.setError(null);
          }
        }}
        title="Review & Charge"
        maxHeight="large"
        dismissible={!pos.success && !pos.isProcessing && !pos.isCreatingIntent}
      >
        {drawerContent}
      </SlideUpDrawer>

      <IdScannerModal
        isOpen={pos.showIdScanner}
        onClose={() => pos.setShowIdScanner(false)}
        onScanComplete={pos.handleIdScanComplete}
        isDark={pos.isDark}
      />
    </div>
  );
};

export default POSRegister;
