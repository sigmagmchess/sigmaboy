CXX ?= g++
CXXFLAGS = -O2 -std=c++17 -Wall -pthread

all: vega vega2

vega: vega.cpp
	$(CXX) $(CXXFLAGS) -o vega vega.cpp

vega2: vega2.cpp
	$(CXX) $(CXXFLAGS) -o vega2 vega2.cpp

clean:
	rm -f vega vega2

.PHONY: all clean
