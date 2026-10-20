SHELL := /bin/bash
PORT ?= 3737
MAX_PORT_TRIES ?= 20

.DEFAULT_GOAL := help

.PHONY: help local restart stop status logs open install uninstall

help:
	@echo ""
	@echo "  make local      start the dashboard in the background, show progress, then the url"
	@echo "  make restart    stop the dashboard, then start it again"
	@echo "  make stop       stop the dashboard"
	@echo "  make status     is the dashboard running, and where"
	@echo "  make logs       follow the server log"
	@echo "  make open       open the dashboard in the browser"
	@echo "  make install    install the claude-dashboard command globally"
	@echo "  make uninstall  remove the global claude-dashboard command"
	@echo ""
	@echo "  pin a port with: make local PORT=4000"
	@echo ""

local:
	@PORT=$(PORT) MAX_PORT_TRIES=$(MAX_PORT_TRIES) ./scripts/dev.sh start

restart:
	@PORT=$(PORT) MAX_PORT_TRIES=$(MAX_PORT_TRIES) ./scripts/dev.sh restart

stop:
	@PORT=$(PORT) ./scripts/dev.sh stop

status:
	@PORT=$(PORT) ./scripts/dev.sh status

logs:
	@./scripts/dev.sh logs

open:
	@PORT=$(PORT) ./scripts/dev.sh open

install:
	npm install -g .

uninstall:
	npm uninstall -g claude-dashboard
