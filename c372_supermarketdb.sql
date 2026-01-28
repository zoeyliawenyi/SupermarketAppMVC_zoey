-- SupermarketAppMVC Database Schema
-- Generated for Project Enhancement

CREATE DATABASE IF NOT EXISTS c372_supermarketdb;
USE c372_supermarketdb;

-- Users Table
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    address TEXT,
    contact VARCHAR(20),
    role ENUM('user', 'admin', 'deleted') DEFAULT 'user',
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Products Table
CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    productName VARCHAR(100) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    stock INT DEFAULT 0,
    category VARCHAR(50),
    dietary VARCHAR(50),
    image VARCHAR(255),
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Orders Table
CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INT,
    total DECIMAL(10, 2) NOT NULL,
    paymentMethod VARCHAR(50),
    deliveryType VARCHAR(50),
    address TEXT,
    status VARCHAR(50) DEFAULT 'placed',
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE SET NULL
);

-- Order Items Table
CREATE TABLE IF NOT EXISTS order_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    orderId INT,
    productId INT,
    productName VARCHAR(100),
    quantity INT NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    FOREIGN KEY (orderId) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (productId) REFERENCES products(id) ON DELETE SET NULL
);

-- Reviews Table
CREATE TABLE IF NOT EXISTS reviews (
    id INT AUTO_INCREMENT PRIMARY KEY,
    productId INT,
    userId INT,
    rating INT CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    reply TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

-- Favorites Table
CREATE TABLE IF NOT EXISTS favorites (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INT,
    productId INT,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_fav (userId, productId),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE
);

-- Cart Items Table 
CREATE TABLE IF NOT EXISTS cart_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INT,
    productId INT,
    quantity INT DEFAULT 1,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_cart (userId, productId),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE
);


-- NETS Transactions Table 
CREATE TABLE IF NOT EXISTS nets_transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INT,
    orderId INT NULL,
    txnRetrievalRef VARCHAR(80) NOT NULL,
    courseInitId VARCHAR(80),
    amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'SGD',
    status VARCHAR(40) DEFAULT 'pending',
    rawResponse JSON NULL,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_txn_ref (txnRetrievalRef),
    INDEX idx_nets_user (userId),
    INDEX idx_nets_order (orderId),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (orderId) REFERENCES orders(id) ON DELETE SET NULL
);


-- Sample Data
INSERT INTO users (username, email, password, address, contact, role) VALUES
('admin', 'admin@zozomart.com', SHA1('admin123'), 'Admin Office', '88888888', 'admin'),
('user', 'user@example.com', SHA1('user123'), '123 User Lane', '99999999', 'user');

INSERT INTO products (productName, description, price, stock, category, dietary, image) VALUES
('Fresh Milk', '1L Full Cream Milk', 3.50, 50, 'Dairy', 'Halal', 'milk.jpg'),
('Organic Eggs', 'Pack of 10 organic eggs', 5.20, 30, 'Dairy', 'Halal', 'eggs.jpg'),
('Wholemeal Bread', 'Freshly baked wholemeal bread', 2.80, 40, 'Bakery', 'Halal', 'bread.jpg'),
('Red Apples', 'Sweet and crunchy red apples (per kg)', 4.50, 100, 'Fruits', 'Vegan', 'apples.jpg'),
('Chicken Breast', 'Fresh chicken breast (500g)', 7.90, 25, 'Meat', 'Halal', 'chicken.jpg'),
('Broccoli', 'Fresh green broccoli', 2.00, 60, 'Vegetables', 'Vegan', 'broccoli.jpg'),
('Basmati Rice', '5kg Premium Basmati Rice', 15.00, 20, 'Grains', 'Halal', 'rice.jpg'),
('Olive Oil', '500ml Extra Virgin Olive Oil', 12.50, 15, 'Oils', 'Vegan', 'olive_oil.jpg');
