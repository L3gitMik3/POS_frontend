import { useEffect, useRef, useState } from "react";

const ENDPOINTS = { products: "/api/v1/inventory/products/", sales: "/api/v1/sales/", customerLookup: "/api/v1/sales/customers/lookup/", mpesa: "/api/v1/payments/mpesa/initiate/", mpesaStatus: "/api/v1/payments/mpesa/status/" };
const listOf = (data) => Array.isArray(data) ? data : data?.results || [];
const money = (n) => Number(n || 0).toLocaleString("en-KE", { style: "currency", currency: "KES", minimumFractionDigits: 2 });
const uuid = () => crypto.randomUUID();
const getStock = (p) => Number(p?.stock_quantity ?? p?.stock ?? p?.quantity_on_hand ?? 0);
const getPrice = (p) => Number(p?.price ?? p?.sale_price ?? p?.selling_price ?? p?.unit_price ?? 0);

function Field({ label, ...props }) {
  return <label className="field"><span>{label}</span><input {...props} /></label>;
}

export default function POS({ apiFetch, till, notify, onCompleted }) {
  const [products, setProducts] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [cart, setCart] = useState([]);
  const [quantityDrafts, setQuantityDrafts] = useState({});
  const [customer, setCustomer] = useState("");
  const [customerLookupState, setCustomerLookupState] = useState(null);
  const [customerLookupBusyPhone, setCustomerLookupBusyPhone] = useState("");
  const [customerLookupVersion, setCustomerLookupVersion] = useState(0);
  const [redeeming, setRedeeming] = useState(false);
  const [redeemInput, setRedeemInput] = useState("");
  const [payMethod, setPayMethod] = useState("cash");
  const [cashGiven, setCashGiven] = useState("");
  const [mpesaPhone, setMpesaPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [lastReceipt, setLastReceipt] = useState(null);
  const checkoutKey = useRef(null);
  const checkoutFingerprint = useRef("");
  const customerPhone = customer.trim();
  const customerLookup = customerLookupState?.phone === customerPhone ? customerLookupState.data : null;
  const customerLookupBusy = Boolean(customerPhone) && customerLookupBusyPhone === customerPhone;

  useEffect(() => {
    const phone = customerPhone;
    if (!phone) return undefined;
    let cancel = false;
    const timer = window.setTimeout(async () => {
      setCustomerLookupBusyPhone(phone);
      try {
        const result = await apiFetch(`${ENDPOINTS.customerLookup}?phone_number=${encodeURIComponent(phone)}`);
        if (!cancel) setCustomerLookupState({ phone, data: result });
      } catch (error) {
        if (!cancel) {
          setCustomerLookupState({ phone, data: null });
          notify("err", error.message || "Could not check customer loyalty points.");
        }
      } finally {
        if (!cancel) setCustomerLookupBusyPhone((current) => current === phone ? "" : current);
      }
    }, 300);
    return () => { cancel = true; window.clearTimeout(timer); };
  }, [apiFetch, customerPhone, customerLookupVersion, notify]);

  useEffect(() => {
    let cancel = false;
    const q = query.trim();
    if (!q) { setProducts([]); setLoading(false); return undefined; }
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const data = await apiFetch(`${ENDPOINTS.products}?search=${encodeURIComponent(q)}`);
        if (!cancel) setProducts(listOf(data));
      } catch (e) {
        if (!cancel) notify("err", e.message || "Could not load products.");
      } finally {
        if (!cancel) setLoading(false);
      }
    }, 250);
    return () => { cancel = true; window.clearTimeout(timer); };
  }, [apiFetch, notify, query]);

  useEffect(() => {
    const transactionId = lastReceipt?.mpesaTransactionId;
    if (!transactionId || lastReceipt.paymentStatus !== "pending") return undefined;
    let cancel = false;
    let timer;
    const checkStatus = async () => {
      try {
        const result = await apiFetch(`${ENDPOINTS.mpesaStatus}${transactionId}/`);
        if (cancel) return;
        if (result.payment_status === "paid") {
          setLastReceipt((current) => current?.mpesaTransactionId === transactionId
            ? { ...current, paymentStatus: "paid", paymentStatusMessage: "" }
            : current);
          notify("ok", "M-Pesa payment confirmed.");
          return;
        }
        if (result.payment_status === "failed") {
          setLastReceipt((current) => current?.mpesaTransactionId === transactionId
            ? { ...current, paymentStatus: "failed", paymentStatusMessage: result.result_description || "Payment was not completed." }
            : current);
          notify("err", result.result_description || "M-Pesa payment was not completed.");
          return;
        }
        setLastReceipt((current) => current?.mpesaTransactionId === transactionId && current.paymentStatusMessage
          ? { ...current, paymentStatusMessage: "" }
          : current);
        timer = window.setTimeout(checkStatus, 3000);
      } catch (error) {
        if (cancel) return;
        setLastReceipt((current) => current?.mpesaTransactionId === transactionId
          ? { ...current, paymentStatusMessage: `Still waiting for confirmation; status check failed: ${error.message}` }
          : current);
        timer = window.setTimeout(checkStatus, 6000);
      }
    };
    timer = window.setTimeout(checkStatus, 2500);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [apiFetch, lastReceipt?.mpesaTransactionId, lastReceipt?.paymentStatus, notify]);

  const filtered = products.slice(0, 40);

  const addToCart = (p) => {
    const available = getStock(p);
    const existing = cart.find((line) => line.product === p.id);
    if (available <= (existing?.quantity || 0)) {
      notify("err", available > 0 ? `Only ${available} ${p.name} in stock.` : `${p.name} is out of stock.`);
      return;
    }
    if (existing) {
      setCart((current) => current.map((line) => line.product === p.id ? { ...line, quantity: line.quantity + 1, available_stock: available } : line));
      return;
    }
    setCart((current) => [...current, { product: p.id, name: p.name, sku: p.sku || p.barcode || "", unit_price: getPrice(p), tax_rate: Number(p.tax_rate ?? 0), quantity: 1, available_stock: available }]);
  };
  const setQty = (id, value) => {
    const quantity = Math.max(0, Number(value) || 0);
    const line = cart.find((item) => item.product === id);
    if (!Number.isInteger(quantity)) {
      notify("err", "Sale quantities must be whole numbers.");
      return;
    }
    if (line && quantity > line.available_stock) {
      notify("err", `Only ${line.available_stock} ${line.name} in stock.`);
      return;
    }
    setCart((current) => current.map((item) => item.product === id ? { ...item, quantity } : item).filter((item) => item.quantity > 0));
  };
  const commitQtyDraft = (id) => {
    const value = quantityDrafts[id];
    if (value !== undefined && value !== "") setQty(id, value);
    setQuantityDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };
  const removeLine = (id) => setCart((current) => current.filter((line) => line.product !== id));
  const clearCart = () => setCart([]);

  const totals = (() => {
    let subtotal = 0;
    let tax = 0;
    for (const line of cart) {
      const lineTotal = line.unit_price * line.quantity;
      subtotal += lineTotal;
      tax += lineTotal * line.tax_rate / 100;
    }
    return { subtotal, tax, total: subtotal + tax };
  })();
  const loyaltyPointsToRedeem = redeeming ? Number(redeemInput || 0) : 0;
  const totalDue = Math.max(0, totals.total - loyaltyPointsToRedeem);
  const change = Math.max(0, Number(cashGiven || 0) - totalDue);

  const submit = async () => {
    if (!till) return notify("err", "Open a till first.");
    if (!cart.length) return notify("err", "Cart is empty.");
    if (redeeming && (!Number.isInteger(loyaltyPointsToRedeem) || loyaltyPointsToRedeem <= 0)) return notify("err", "Enter a positive whole number of loyalty points to redeem.");
    if (redeeming && loyaltyPointsToRedeem > Number(customerLookup?.available_points || 0)) return notify("err", "The customer does not have enough available loyalty points.");
    if (redeeming && loyaltyPointsToRedeem > Math.floor(totals.total)) return notify("err", "The sale total is too low to redeem that many loyalty points.");
    if (payMethod === "cash" && Number(cashGiven || 0) < totalDue) return notify("err", "Cash tendered is less than the total.");
    if (payMethod === "mpesa" && !mpesaPhone.trim()) return notify("err", "Enter the M-Pesa phone number.");
    setSubmitting(true);
    try {
      const checkoutData = {
        till_session: till.id,
        customer_phone: customer.trim() || (payMethod === "mpesa" ? mpesaPhone.trim() : undefined),
        loyalty_points_redeemed: loyaltyPointsToRedeem,
        payment_method: payMethod,
        cash_received: payMethod === "cash" ? cashGiven : undefined,
        cart_lines: cart.map((line) => ({ product_id: line.product, quantity: line.quantity, unit_price: line.unit_price, tax_rate: line.tax_rate })),
      };
      const fingerprint = JSON.stringify(checkoutData);
      if (!checkoutKey.current || checkoutFingerprint.current !== fingerprint) {
        checkoutKey.current = uuid();
        checkoutFingerprint.current = fingerprint;
      }
      const sale = await apiFetch(ENDPOINTS.sales, {
        method: "POST",
        body: { ...checkoutData, client_uuid: checkoutKey.current },
        headers: { "Idempotency-Key": checkoutKey.current },
        timeoutMs: 30000,
      });
      let mpesaSubmitted = false;
      let mpesaTransactionId = "";
      if (payMethod === "mpesa") {
        try {
          const payment = await apiFetch(ENDPOINTS.mpesa, { method: "POST", body: { sale_id: sale.id, phone_number: mpesaPhone.trim() } });
          mpesaSubmitted = true;
          mpesaTransactionId = payment.id;
          notify("ok", "M-Pesa payment request submitted.");
        } catch (error) {
          notify("err", `M-Pesa payment was not confirmed; the sale is not paid: ${error.message}`);
        }
      }
      setLastReceipt({ number: sale.receipt_number || sale.id, date: new Date(), customer: sale.customer_phone || customer.trim() || (payMethod === "mpesa" ? mpesaPhone.trim() : ""), paymentMethod: payMethod, paymentStatus: payMethod === "cash" ? "paid" : mpesaSubmitted ? "pending" : "not confirmed", paymentStatusMessage: "", mpesaTransactionId, lines: cart.map((line) => ({ ...line })), subtotal: Number(sale.subtotal), tax: Number(sale.tax_amount), total: Number(sale.total_amount), pointsRedeemed: sale.loyalty_points_redeemed || 0, pointsEarned: sale.loyalty_points_earned || 0, cashGiven: payMethod === "cash" ? Number(cashGiven || 0) : null, change });
      if (payMethod === "cash") onCompleted?.(sale);
      clearCart();
      setRedeeming(false);
      setRedeemInput("");
      setCustomerLookupVersion((version) => version + 1);
      checkoutKey.current = null;
      checkoutFingerprint.current = "";
      setCashGiven("");
      setMpesaPhone("");
    } catch (error) {
      notify("err", error.message || "Could not complete sale.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pos">
      <section className="card pos-products">
        <div className="section-intro"><span className="eyebrow">CATALOG</span><h2>Products</h2></div>
        <input className="pos-search" placeholder="Search name, SKU, or barcode…" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
        {loading ? <p className="muted">Loading products…</p> : !query.trim() ? <p className="muted">Search by product name, SKU, or barcode to find items.</p> : (
          <ul className="product-list">
            {filtered.map((product) => <li key={product.id}><button className="product-row" onClick={() => addToCart(product)}><div><strong>{product.name}</strong><span className="muted-small">{product.sku || product.barcode || "—"} · {getStock(product)} in stock</span></div><div className="product-price">{money(getPrice(product))}</div></button></li>)}
            {!filtered.length && <li className="muted">No products match that name, SKU, or barcode.</li>}
          </ul>
        )}
      </section>
      <section className="card pos-cart">
        <div className="section-intro"><span className="eyebrow">CART</span><h2>Current sale</h2></div>
        <Field label="Customer phone (optional)" value={customer} onChange={(event) => { setCustomer(event.target.value); setCustomerLookup(null); setRedeeming(false); setRedeemInput(""); }} placeholder="e.g. 254712345678" />
        {customer.trim() && <p className="muted">{customerLookupBusy ? "Checking loyalty balance…" : customerLookup ? `${customerLookup.available_points} loyalty point(s) available · Earn 1 point per KSh 200 paid.` : "Customer loyalty balance unavailable."}</p>}
        {Number(customerLookup?.available_points || 0) > 0 && !redeeming && <button type="button" className="ghost small" onClick={() => setRedeeming(true)}>Redeem points</button>}
        {redeeming && <div className="pay-extra"><Field label={`Points to redeem (1 point = KSh 1; max ${Math.min(Number(customerLookup?.available_points || 0), Math.floor(totals.total))})`} type="number" min="1" max={Math.min(Number(customerLookup?.available_points || 0), Math.floor(totals.total))} step="1" value={redeemInput} onChange={(event) => setRedeemInput(event.target.value)} /><button type="button" className="ghost small" onClick={() => { setRedeeming(false); setRedeemInput(""); }}>Cancel redemption</button></div>}
        {!cart.length ? <p className="muted">Cart is empty. Tap products to add.</p> : (
          <ul className="cart-list">{cart.map((line) => <li key={line.product} className="cart-line"><div className="cart-line-head"><strong>{line.name}</strong><button className="ghost small" onClick={() => removeLine(line.product)}>Remove</button></div><div className="cart-line-body"><div className="qty"><button onClick={() => setQty(line.product, line.quantity - 1)}>−</button><input type="number" min="1" value={quantityDrafts[line.product] ?? line.quantity} onChange={(event) => setQuantityDrafts((current) => ({ ...current, [line.product]: event.target.value }))} onBlur={() => commitQtyDraft(line.product)} /><button onClick={() => setQty(line.product, line.quantity + 1)}>+</button></div><div className="cart-price">{money(line.unit_price * line.quantity)}</div></div></li>)}</ul>
        )}
        <div className="totals"><div><span>Subtotal</span><strong>{money(totals.subtotal)}</strong></div><div><span>Tax</span><strong>{money(totals.tax)}</strong></div>{loyaltyPointsToRedeem > 0 && <div><span>Loyalty points</span><strong>−{money(loyaltyPointsToRedeem)}</strong></div>}<div className="grand"><span>Total due</span><strong>{money(totalDue)}</strong></div></div>
        <div className="pay-methods"><button className={`pay-chip ${payMethod === "cash" ? "on" : ""}`} onClick={() => setPayMethod("cash")}>Cash</button><button className={`pay-chip ${payMethod === "mpesa" ? "on" : ""}`} onClick={() => setPayMethod("mpesa")}>M-Pesa</button></div>
        {payMethod === "cash" && <div className="pay-extra"><Field label="Cash tendered" type="number" step="0.01" value={cashGiven} onChange={(event) => setCashGiven(event.target.value)} /><div className="change"><span>Change</span><strong>{money(change)}</strong></div></div>}
        {payMethod === "mpesa" && <div className="pay-extra"><Field label="Phone number" value={mpesaPhone} onChange={(event) => setMpesaPhone(event.target.value)} placeholder="254712345678" /></div>}
        <div className="cart-actions"><button className="ghost" onClick={clearCart} disabled={!cart.length || submitting}>Clear</button><button className="primary" onClick={submit} disabled={submitting || !cart.length}>{submitting ? "Processing…" : `Charge ${money(totalDue)}`}</button></div>
        {lastReceipt && <div className="receipt printable-receipt"><div className="receipt-head"><span className="eyebrow">RECEIPT</span><strong>#{lastReceipt.number}</strong><span>{lastReceipt.date.toLocaleString()}</span></div>{lastReceipt.customer && <span>Customer: {lastReceipt.customer}</span>}<span>Payment: {lastReceipt.paymentMethod === "mpesa" ? `M-Pesa — ${lastReceipt.paymentStatus}` : "Cash — paid"}</span>{lastReceipt.paymentStatusMessage && <span role="status">{lastReceipt.paymentStatusMessage}</span>}<div className="receipt-lines">{lastReceipt.lines.map((line) => <div className="receipt-line" key={line.product}><span>{line.name} x {line.quantity}</span><strong>{money(line.unit_price * line.quantity)}</strong></div>)}</div><div className="receipt-total"><div><span>Subtotal</span><strong>{money(lastReceipt.subtotal)}</strong></div><div><span>Tax</span><strong>{money(lastReceipt.tax)}</strong></div>{lastReceipt.pointsRedeemed > 0 && <div><span>Points redeemed</span><strong>{lastReceipt.pointsRedeemed}</strong></div>}<div><span>Total</span><strong>{money(lastReceipt.total)}</strong></div>{lastReceipt.pointsEarned > 0 && <div><span>Points earned</span><strong>{lastReceipt.pointsEarned}</strong></div>}{lastReceipt.cashGiven !== null && <div><span>Cash</span><strong>{money(lastReceipt.cashGiven)}</strong></div>}{lastReceipt.cashGiven !== null && <div><span>Change</span><strong>{money(lastReceipt.change)}</strong></div>}</div><button className="primary receipt-print" onClick={() => window.print()}>Print receipt</button></div>}
      </section>
    </div>
  );
}