const Product = require('../models/Product');

const ProductController = {
    showHome: (req, res) => {
        Product.getLimited(8, (err, products) => {
            if (err) {
                console.error('Home products error:', err);
                return res.render('index', { user: req.session.user, products: [] });
            }
            res.render('index', { user: req.session.user, products: products || [] });
        });
    },

    showShopping: (req, res) => {
        Product.getAll((err, products) => {
            if (err) {
                console.error('Shopping products error:', err);
                return res.status(500).send('Database error');
            }
            res.render('shopping', { 
                user: req.session.user, 
                products: products || [], 
                favoriteIds: res.locals.favoriteIds || [] 
            });
        });
    },

    showProductDetail: (req, res) => {
        const productId = req.params.id;
        Product.getById(productId, (err, product) => {
            if (err) {
                console.error('Product detail error:', err);
                return res.status(500).send('Database error');
            }
            if (!product) return res.status(404).send('Product not found');

            // Fetch reviews for this product
            const Review = require('../models/Review');
            Review.listByProduct(productId, (revErr, reviews) => {
                res.render('product', { 
                    product, 
                    user: req.session.user, 
                    reviews: reviews || [] 
                });
            });
        });
    },

    showInventory: (req, res) => {
        Product.getAll((err, products) => {
            if (err) {
                console.error('Inventory error:', err);
                return res.status(500).send('Database error');
            }
            const lowStock = (products || []).filter(p => Number(p.stock) < 20);
            res.render('inventory', { 
                products: products || [], 
                user: req.session.user, 
                lowStock 
            });
        });
    },

    updateStock: (req, res) => {
        const productId = req.params.id;
        const newStock = parseInt(req.body.stock, 10);
        if (Number.isNaN(newStock) || newStock < 0) {
            return res.status(400).send('Invalid stock value');
        }
        Product.updateStock(productId, newStock, (err) => {
            if (err) {
                console.error('Stock update error:', err);
                return res.status(500).send('Database error');
            }
            res.redirect('/inventory');
        });
    },

    showAddProduct: (req, res) => {
        res.render('addProduct', { user: req.session.user });
    },

    addProduct: (req, res) => {
        const { name, stock, price, category, description, dietary } = req.body;
        if (!name || !stock || !price || !category || !description || !dietary) {
            req.flash('error', 'All fields are required');
            return res.redirect('/addProduct');
        }
        const image = req.file ? req.file.filename : null;

        Product.create({ name, stock, price, image, category, description, dietary }, (err) => {
            if (err) {
                console.error('Add product error:', err);
                return res.status(500).send('Error adding product');
            }
            res.redirect('/inventory');
        });
    },

    showEditProduct: (req, res) => {
        const productId = req.params.id;
        Product.getById(productId, (err, product) => {
            if (err) {
                console.error('Edit product GET error:', err);
                return res.status(500).send('Database error');
            }
            if (!product) return res.status(404).send('Product not found');
            res.render('editProduct', { product, user: req.session.user });
        });
    },

    updateProduct: (req, res) => {
        const productId = req.params.id;
        const { name, stock, price, category, description, dietary } = req.body;
        if (!name || !stock || !price || !category || !description || !dietary) {
            req.flash('error', 'All fields are required');
            return res.redirect(`/editProduct/${productId}`);
        }
        let image = req.body.currentImage;
        if (req.file) image = req.file.filename;

        Product.update(productId, { name, stock, price, image, category, description, dietary }, (err) => {
            if (err) {
                console.error('Update product error:', err);
                return res.status(500).send('Error updating product');
            }
            res.redirect('/inventory');
        });
    },

    deleteProduct: (req, res) => {
        const productId = req.params.id;
        Product.delete(productId, (err) => {
            if (err) {
                console.error('Delete product error:', err);
                return res.status(500).send('Error deleting product');
            }
            res.redirect('/inventory');
        });
    }
};

module.exports = ProductController;
