# Entry point for cPanel's "Setup Python App" (Phusion Passenger).
# Only used on shared/cPanel hosting — gunicorn (via Procfile) is used everywhere else.
from app import app as application
