"""
Shipping integration scaffold — inactive until configured.

Digital products (the current catalog: mp3/wav tracks, video downloads) don't need
this at all; it's here for when physical merchandise gets added to `products`.

Set SHIPPING_PROVIDER (shippo|easypost) and SHIPPING_API_KEY in backend/.env to
activate. Both providers expose plain REST APIs, so this hits them directly with
`requests` instead of pulling in a provider-specific SDK — switching providers later
is a config change, not a rewrite.
"""
import os

import requests

PROVIDER = os.environ.get("SHIPPING_PROVIDER", "").strip().lower()
API_KEY = os.environ.get("SHIPPING_API_KEY", "").strip()

SHIP_FROM_ADDRESS = {
    "name": os.environ.get("SHIP_FROM_NAME", "Kingdom Stores"),
    "street1": os.environ.get("SHIP_FROM_STREET1", ""),
    "city": os.environ.get("SHIP_FROM_CITY", ""),
    "state": os.environ.get("SHIP_FROM_STATE", ""),
    "zip": os.environ.get("SHIP_FROM_ZIP", ""),
    "country": os.environ.get("SHIP_FROM_COUNTRY", "US"),
}


def is_configured():
    return bool(PROVIDER and API_KEY)


class ShippingNotConfigured(RuntimeError):
    pass


def get_rates(address_to, parcel):
    """address_to: {name, street1, city, state, zip, country}
    parcel: {length, width, height, distance_unit, weight, mass_unit}
    Returns [{carrier, service, rate, currency, rate_id}, ...]
    """
    if not is_configured():
        raise ShippingNotConfigured(
            "Set SHIPPING_PROVIDER and SHIPPING_API_KEY in backend/.env to enable shipping."
        )
    if PROVIDER == "shippo":
        return _shippo_rates(address_to, parcel)
    if PROVIDER == "easypost":
        return _easypost_rates(address_to, parcel)
    raise ShippingNotConfigured(f"Unsupported SHIPPING_PROVIDER: {PROVIDER!r}")


def buy_label(rate_id):
    """Purchases the shipping label for a previously-quoted rate id.
    Returns {tracking_number, label_url, carrier}.
    """
    if not is_configured():
        raise ShippingNotConfigured(
            "Set SHIPPING_PROVIDER and SHIPPING_API_KEY in backend/.env to enable shipping."
        )
    if PROVIDER == "shippo":
        return _shippo_buy_label(rate_id)
    if PROVIDER == "easypost":
        raise NotImplementedError(
            "EasyPost label purchase needs the shipment id alongside the rate id — "
            "wire this up when EasyPost is the chosen provider."
        )
    raise ShippingNotConfigured(f"Unsupported SHIPPING_PROVIDER: {PROVIDER!r}")


# ---- Shippo (https://docs.goshippo.com) ------------------------------------------
def _shippo_rates(address_to, parcel):
    resp = requests.post(
        "https://api.goshippo.com/shipments/",
        headers={"Authorization": f"ShippoToken {API_KEY}"},
        json={
            "address_to": address_to,
            "address_from": SHIP_FROM_ADDRESS,
            "parcels": [parcel],
            "async": False,
        },
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    return [
        {
            "carrier": r["provider"],
            "service": r["servicelevel"]["name"],
            "rate": r["amount"],
            "currency": r["currency"],
            "rate_id": r["object_id"],
        }
        for r in data.get("rates", [])
    ]


def _shippo_buy_label(rate_id):
    resp = requests.post(
        "https://api.goshippo.com/transactions/",
        headers={"Authorization": f"ShippoToken {API_KEY}"},
        json={"rate": rate_id, "label_file_type": "PDF", "async": False},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    return {
        "tracking_number": data.get("tracking_number"),
        "label_url": data.get("label_url"),
        "carrier": (data.get("rate") or {}).get("provider"),
    }


# ---- EasyPost (https://docs.easypost.com) -----------------------------------------
def _easypost_rates(address_to, parcel):
    resp = requests.post(
        "https://api.easypost.com/v2/shipments",
        auth=(API_KEY, ""),
        json={"shipment": {"to_address": address_to, "from_address": SHIP_FROM_ADDRESS, "parcel": parcel}},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    return [
        {
            "carrier": r["carrier"],
            "service": r["service"],
            "rate": r["rate"],
            "currency": r["currency"],
            "rate_id": r["id"],
        }
        for r in data.get("rates", [])
    ]
