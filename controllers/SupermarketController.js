const Supermarket = require('../models/Supermarket');

// Display all products
const showAllProducts = (req, res) => {
    Supermarket.getAllProducts((err, results) => {
        if (err) {
            console.error('Error retrieving products:', err);
            return res.status(500).send('Error retrieving products');
        }
        res.render('inventory', { products: results });
    });
};

// Display one product by ID
const showProductById = (req, res) => {
    const id = req.params.id;
    Supermarket.getProductById(id, (err, results) => {
        if (err) {
            console.error('Error retrieving product:', err);
            return res.status(500).send('Error retrieving product');
        } else if (results && results.length > 0) {
            return res.render('product', { product: results[0] });
        } else {
            return res.status(404).send('Product not found');
        }
    });
};

// Show add product form
const showAddForm = (req, res) => {
    res.render('addProduct');
};

// Handle adding product
const addProduct = (req, res) => {
    const { productName, price, description, category } = req.body;
    const image = req.file ? req.file.filename : null;

    Supermarket.addProduct(productName, price, description, category, image, (err, results) => {
        if (err) {
            console.error('Error adding product:', err);
            return res.status(500).send('Error adding product');
        }
        res.redirect('/inventory');
    });
};

// Show edit form
const showEditForm = (req, res) => {
    const id = req.params.id;
    Supermarket.getProductById(id, (err, results) => {
        if (err) {
            console.error('Error retrieving product:', err);
            return res.status(500).send('Error retrieving product');
        } else if (results && results.length > 0) {
            return res.render('editProduct', { product: results[0] });
        } else {
            return res.status(404).send('Product not found');
        }
    });
};

// Handle edit product
const updateProduct = (req, res) => {
    const id = req.params.id;
    const { productName, price, description, category, currentImage } = req.body;
    const image = req.file ? req.file.filename : currentImage;

    Supermarket.updateProduct(id, productName, price, description, category, image, (err, results) => {
        if (err) {
            console.error('Error updating product:', err);
            return res.status(500).send('Error updating product');
        }
        res.redirect('/inventory');
    });
};

// Handle delete product
const deleteProduct = (req, res) => {
    const id = req.params.id;
    Supermarket.deleteProduct(id, (err, results) => {
        if (err) {
            console.error('Error deleting product:', err);
            return res.status(500).send('Error deleting product');
        }
        res.redirect('/inventory');
    });
};

module.exports = {
    showAllProducts,
    showProductById,
    showAddForm,
    addProduct,
    showEditForm,
    updateProduct,
    deleteProduct
};