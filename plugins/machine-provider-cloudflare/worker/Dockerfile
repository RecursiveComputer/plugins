# The image a Recursive runner starts from. The runner installs anything else it
# needs (agent CLIs) on first use; preinstall them here to make first turns faster.
FROM node:24-trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /root
CMD ["sleep", "infinity"]
