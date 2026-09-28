// ВСЕ селекторы и тексты сайта в одном месте (§9).
// Места, помеченные [НЕ СНЯТО], — догадки: уточнить по живой разметке (T4/T5).

export const SEL = {
  // конфигурация
  noTradeIn: '[data-autom="choose-noTradeIn"]',
  noAppleCare: '[data-autom="noapplecare"]',
  addToBag: '[data-autom="add-to-cart"]',
  continueDisabled: '[data-autom="continueButton"]',
  productName: '[data-autom="summary-productName"]',
  atbProductField: 'input[name="product"]',
  // корзина
  bagItemName: '[data-autom="bag-item-name"]',
  bagItemRemove: '[data-autom="bag-item-remove-button"]',
  bagItemQty: '[data-autom="item-quantity-dropdown"]',
  bagCheckout: '[data-autom="checkout"]',
  bagApplePay: '[data-autom="checkout-with-apple-pay"]',
  bagTotal: '[data-autom="bagtotalvalue"]',
  // вход
  guest: '[data-autom="guest-checkout-btn"]',
  // fulfillment
  segmented: 'button.rc-segmented-control-button',
  segmentedSelectedClass: 'rc-segmented-control-selected',
  city: 'select[data-autom="form-field-city"]',
  storeRadioAny: 'input[name="store-locator-result"]',
  storeRadio: (id: string) => `input[name="store-locator-result"][value="${id}"]`,
  storeResults: '[data-autom="rt-storelocator-searchresult"]',
  dateRadio: 'input[name="bartPickupDateSelectorButtonGroup"]',
  slotSelect: 'select[data-autom="pickup-availablewindow-dropdown"]',
  fulfillmentContinue: '[data-autom="fulfillment-continue-button"]',
  deliveryOption: 'input[data-autom^="fulfillment-option"]',
  // доставка (фолбэк)
  shipStreet: '[data-autom="form-field-street"]',
  shipStreet2: '[data-autom="form-field-street2"]',
  shipCity: '[data-autom="form-field-city"]',
  shippingContinue: '[data-autom="shipping-continue-button"]',
  // контакты
  selfPickup: '[data-autom="selfPickup"]',
  thirdPartyPickup: '[data-autom="thirdPartyPickup"]',
  firstName: '[data-autom="form-field-firstName"]',
  lastName: '[data-autom="form-field-lastName"]',
  email: '[data-autom="form-field-emailAddress"]',
  phone: '[data-autom="form-field-mobilePhone"]',
  contactContinue: '[data-autom="continue-button-label"]',
  // оплата: только выбор способа и фокус
  payCard: '[data-autom="checkout-billingOptions-CREDIT"]',
  payApplePay: '[data-autom="checkout-billingOptions-APPLE_PAY"]',
  cardNumberFocusOnly: '[data-autom="card-number-input"]',
  reviewButtonObserveOnly: '[data-autom="continue-button-review"]',
  // выбор страны [НЕ СНЯТО] — глобальный locale switcher apple.com + общие варианты
  countryContainers: [
    '#ac-ls', '.ac-ls', 'aside[class*="localeswitcher"]', '[class*="locale-switcher"]',
    '[class*="country-selector"]', '[role="dialog"]', '[aria-modal="true"]',
  ],
  countryClose: '.ac-ls-close, button[aria-label*="lose" i], [data-autom*="close" i]',
  // тексты
  txtPreorder: 'Pre-order starting',
  txtBusy: /(so are we|Almost there|Be right back|busy right now|high demand|isn.t available right now)/i,
  // магазин закрыт перед дропом («We'll be back», жёлтый стикер) [точный текст AE не снят]
  txtClosed: /(We.ll be back|be back soon|back shortly|making updates|updating the (Apple )?(Online )?Store|Check back (soon|later)|store is (currently )?(closed|unavailable)|temporarily unavailable)/i,
  txt404: /can.t be found|Page Not Found/i,
  txtCountry: /(Choose another country or region|country or region|You.re viewing)/i, // уточнить по живой разметке
  txtUAE: /United Arab Emirates|\bUAE\b/i,
  txtContinue: /^\s*(Continue|Go|Stay)/i,
  txtSlotError: /(no longer available|not available for|Please select|Please choose)/i,
  txtContactError: /Please\s[^.\n]{3,120}/i,
  txtEmptyBag: /Your bag is empty/i,
  txtOrderNo: /\bW\d{9,11}\b/,
  txtThanks: /(thank you|your order number|order number)/i,
  txtPickup: /pick\s*it\s*up|pickup/i,
  txtDelivered: /deliver/i,
  txtUnavailable: /(unavailable|Not available)/i,
  txtMaxQty: /maximum of \d+/i,
} as const;
