const db = require('../db');

// Retrieve all products
const getAllProducts = (callback) => {
    const sql = 'SELECT * FROM products';
    db.query(sql, callback);
};

// Retrieve a product by ID
const getProductById = (id, callback) => {
    const sql = 'SELECT * FROM products WHERE id = ?';
    db.query(sql, [id], callback);
};

// Add a new product
const addProduct = (productName, price, description, category, image, callback) => {
    const sql = 'INSERT INTO products (productName, price, description, category, image) VALUES (?, ?, ?, ?, ?)';
    db.query(sql, [productName, price, description, category, image], callback);
};

// Update a product’s details
const updateProduct = (id, productName, price, description, category, image, callback) => {
    const sql = 'UPDATE products SET productName = ?, price = ?, description = ?, category = ?, image = ? WHERE id = ?';
    db.query(sql, [productName, price, description, category, image, id], callback);
};

// Delete a product
const deleteProduct = (id, callback) => {
    const sql = 'DELETE FROM products WHERE id = ?';
    db.query(sql, [id], callback);
};

module.exports = {
    getAllProducts,
    getProductById,
    addProduct,
    updateProduct,
    deleteProduct
};