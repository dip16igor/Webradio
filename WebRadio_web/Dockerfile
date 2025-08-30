# Use an official Node.js runtime as a parent image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to leverage Docker cache
COPY package*.json ./

# Install app dependencies
RUN npm install

# Copy the rest of the application source code
COPY . .

# Create a non-root user and group
RUN addgroup -S node && adduser -S -G node node

# Change ownership of the app directory
RUN chown -R node:node /usr/src/app

# Switch to the non-root user
USER node

# Make port 3000 available to the world outside this container
EXPOSE 3000

# Define the command to run your app
CMD [ "node", "server.js" ]