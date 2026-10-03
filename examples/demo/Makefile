.PHONY: build test clean

build:
	@echo -e "building $(shell date +%s)\n"
	cp --force config/app.conf build/app.conf
	find . -name '*.log' | xargs -d '\n' rm -f

test:
	timeout 60 ./run-tests.sh
	@ps --no-headers -p $$$$ > /dev/null

clean:
	rm --recursive --force build
