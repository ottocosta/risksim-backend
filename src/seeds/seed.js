// Sample seed file
const ExampleModel = require('../models/example');

const seedDB = async () => {
    await ExampleModel.deleteMany({});
    await ExampleModel.insertMany([{
        name: 'Sample1',
        value: 10,
    }, {
        name: 'Sample2',
        value: 20,
    }]);
};

seedDB();